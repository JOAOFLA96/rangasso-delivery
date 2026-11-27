import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { cleanText } from '../../lib/text.js';
import { parse } from '../../lib/validate.js';
import { requireRole } from '../../auth.js';
import { COUPON_CODE_RE, couponLabel, normalizeCouponCode } from '../../services/coupons.js';

const couponBody = z.object({
  code: z.string().trim().min(1).max(30),
  description: z.string().max(120).optional().default(''),
  kind: z.enum(['percent', 'fixed', 'free_delivery']),
  percent: z.number().int().min(1).max(100).nullable().optional(),
  amountCents: z.number().int().min(1).max(100_000_00).nullable().optional(),
  maxDiscountCents: z.number().int().min(1).max(100_000_00).nullable().optional(),
  minOrderCents: z.number().int().min(0).max(100_000_00).optional().default(0),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  maxUses: z.number().int().min(1).max(1_000_000).nullable().optional(),
  maxUsesPerPhone: z.number().int().min(1).max(1000).nullable().optional(),
  firstOrderOnly: z.boolean().optional().default(false),
  active: z.boolean().optional().default(true),
});
type CouponBody = z.infer<typeof couponBody>;

function check(b: CouponBody) {
  const code = normalizeCouponCode(b.code);
  if (!COUPON_CODE_RE.test(code)) throw badRequest('invalid_code', 'O código precisa ter de 3 a 20 letras, números, "-" ou "_" (sem espaços).', { field: 'code' });
  if (b.kind === 'percent' && !b.percent) throw badRequest('invalid_percent', 'Informe a porcentagem do desconto (1 a 100).', { field: 'percent' });
  if (b.kind === 'fixed' && !b.amountCents) throw badRequest('invalid_amount', 'Informe o valor do desconto.', { field: 'amountCents' });
  if (b.startsAt && b.endsAt && new Date(b.endsAt) <= new Date(b.startsAt)) throw badRequest('invalid_dates', 'O fim da validade precisa ser depois do início.', { field: 'endsAt' });
  return {
    code,
    description: cleanText(b.description, 120),
    kind: b.kind,
    percent: b.kind === 'percent' ? b.percent! : null,
    amountCents: b.kind === 'fixed' ? b.amountCents! : null,
    maxDiscountCents: b.kind === 'percent' ? b.maxDiscountCents ?? null : null,
    minOrderCents: b.minOrderCents,
    startsAt: b.startsAt ?? null,
    endsAt: b.endsAt ?? null,
    maxUses: b.maxUses ?? null,
    maxUsesPerPhone: b.maxUsesPerPhone ?? null,
    firstOrderOnly: b.firstOrderOnly,
    active: b.active,
  };
}

const dateQ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

export async function adminCouponRoutes(app: FastifyInstance) {
  const managers = { preHandler: requireRole('owner', 'manager') };
  const actor = (req: any) => ({ storeId: req.admin.storeId, userId: req.admin.userId, ip: req.ip });

  // Lista com o relatório de cada cupom no período (sem período: desde sempre). Cancelados não contam.
  app.get('/coupons', async (req) => {
    const q = parse(z.object({ from: dateQ, to: dateQ }), req.query);
    const storeId = req.admin!.storeId;
    const r = await pool.query(
      `WITH tz AS (SELECT timezone FROM store_settings WHERE store_id = $1)
       SELECT c.*,
              count(o.id) FILTER (WHERE o.status <> 'cancelled')::int AS uses,
              coalesce(sum(o.discount_cents) FILTER (WHERE o.status <> 'cancelled'), 0)::int AS discount_total_cents,
              coalesce(sum(o.total_cents) FILTER (WHERE o.status <> 'cancelled'), 0)::int AS revenue_cents,
              coalesce(sum(o.subtotal_cents) FILTER (WHERE o.status <> 'cancelled'), 0)::int AS subtotal_cents,
              count(DISTINCT o.customer_phone) FILTER (WHERE o.status <> 'cancelled')::int AS customers,
              count(o.id) FILTER (WHERE o.status = 'cancelled')::int AS cancelled,
              max(o.created_at) FILTER (WHERE o.status <> 'cancelled') AS last_used_at,
              (SELECT count(*)::int FROM orders a WHERE a.coupon_id = c.id AND a.status <> 'cancelled') AS uses_all_time
         FROM coupons c
         LEFT JOIN orders o ON o.coupon_id = c.id
              AND ($2::date IS NULL OR o.created_at >= ($2::date)::timestamp AT TIME ZONE (SELECT timezone FROM tz))
              AND ($3::date IS NULL OR o.created_at < (($3::date) + 1)::timestamp AT TIME ZONE (SELECT timezone FROM tz))
        WHERE c.store_id = $1 AND c.archived_at IS NULL
        GROUP BY c.id
        ORDER BY c.active DESC, c.created_at DESC`,
      [storeId, q.from ?? null, q.to ?? null],
    );
    const now = new Date();
    return {
      coupons: r.rows.map((c) => ({
        id: c.id, code: c.code, description: c.description, kind: c.kind, percent: c.percent, amountCents: c.amount_cents,
        maxDiscountCents: c.max_discount_cents, minOrderCents: c.min_order_cents, startsAt: c.starts_at, endsAt: c.ends_at,
        maxUses: c.max_uses, maxUsesPerPhone: c.max_uses_per_phone, firstOrderOnly: c.first_order_only, active: c.active,
        label: couponLabel(c), createdAt: c.created_at,
        status: !c.active ? 'inactive'
          : c.ends_at && new Date(c.ends_at) <= now ? 'expired'
          : c.starts_at && new Date(c.starts_at) > now ? 'scheduled'
          : c.max_uses != null && c.uses_all_time >= c.max_uses ? 'exhausted' : 'active',
        report: {
          uses: c.uses, usesAllTime: c.uses_all_time, customers: c.customers, cancelled: c.cancelled, lastUsedAt: c.last_used_at,
          discountTotalCents: c.discount_total_cents, revenueCents: c.revenue_cents, subtotalCents: c.subtotal_cents,
          averageTicketCents: c.uses ? Math.round(c.revenue_cents / c.uses) : 0,
        },
      })),
    };
  });

  app.post('/coupons', managers, async (req) => {
    const b = check(parse(couponBody, req.body));
    return tx(async (db) => {
      try {
        const r = await db.query(
          `INSERT INTO coupons (store_id, code, description, kind, percent, amount_cents, max_discount_cents, min_order_cents, starts_at, ends_at,
              max_uses, max_uses_per_phone, first_order_only, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
          [req.admin!.storeId, b.code, b.description, b.kind, b.percent, b.amountCents, b.maxDiscountCents, b.minOrderCents, b.startsAt, b.endsAt,
            b.maxUses, b.maxUsesPerPhone, b.firstOrderOnly, b.active],
        );
        await audit(db, actor(req), 'coupon.create', 'coupon', r.rows[0].id, b);
        return { id: r.rows[0].id };
      } catch (e: any) {
        if (e?.code === '23505') throw badRequest('duplicate_code', `Já existe um cupom com o código ${b.code}.`, { field: 'code' });
        throw e;
      }
    });
  });

  app.put<{ Params: { id: string } }>('/coupons/:id', managers, async (req) => {
    const id = parse(z.string().uuid(), req.params.id);
    const b = check(parse(couponBody, req.body));
    return tx(async (db) => {
      const before = (await db.query('SELECT code FROM coupons WHERE id = $1 AND store_id = $2 AND archived_at IS NULL FOR UPDATE', [id, req.admin!.storeId])).rows[0];
      if (!before) throw notFound('Cupom');
      // Código de cupom já usado não muda (os pedidos e relatórios guardam o código).
      if (before.code !== b.code) {
        const used = await db.query('SELECT 1 FROM orders WHERE coupon_id = $1 LIMIT 1', [id]);
        if (used.rowCount) throw badRequest('code_locked', 'Este cupom já foi usado: o código não pode mudar. Crie um cupom novo.', { field: 'code' });
      }
      try {
        await db.query(
          `UPDATE coupons SET code=$3, description=$4, kind=$5, percent=$6, amount_cents=$7, max_discount_cents=$8, min_order_cents=$9,
              starts_at=$10, ends_at=$11, max_uses=$12, max_uses_per_phone=$13, first_order_only=$14, active=$15, updated_at=now()
            WHERE id=$1 AND store_id=$2`,
          [id, req.admin!.storeId, b.code, b.description, b.kind, b.percent, b.amountCents, b.maxDiscountCents, b.minOrderCents,
            b.startsAt, b.endsAt, b.maxUses, b.maxUsesPerPhone, b.firstOrderOnly, b.active],
        );
      } catch (e: any) {
        if (e?.code === '23505') throw badRequest('duplicate_code', `Já existe um cupom com o código ${b.code}.`, { field: 'code' });
        throw e;
      }
      await audit(db, actor(req), 'coupon.update', 'coupon', id, b);
      return { ok: true };
    });
  });

  // Excluir: some da lista. Cupom já usado fica guardado (os pedidos apontam para ele) e o código pode ser reaproveitado.
  app.delete<{ Params: { id: string } }>('/coupons/:id', managers, async (req) => {
    const id = parse(z.string().uuid(), req.params.id);
    return tx(async (db) => {
      const c = (await db.query('SELECT code FROM coupons WHERE id = $1 AND store_id = $2 AND archived_at IS NULL FOR UPDATE', [id, req.admin!.storeId])).rows[0];
      if (!c) throw notFound('Cupom');
      const used = await db.query('SELECT 1 FROM orders WHERE coupon_id = $1 LIMIT 1', [id]);
      if (used.rowCount) await db.query('UPDATE coupons SET archived_at = now(), active = false, updated_at = now() WHERE id = $1', [id]);
      else await db.query('DELETE FROM coupons WHERE id = $1', [id]);
      await audit(db, actor(req), 'coupon.delete', 'coupon', id, { code: c.code, kept: !!used.rowCount });
      return { ok: true };
    });
  });
}
