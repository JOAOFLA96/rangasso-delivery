import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { requireRole } from '../../auth.js';
import { emitStoreEvent } from '../../lib/events.js';
import { createLabelPrintJob } from '../../services/print.js';

// Etiquetas de validade da cozinha (insumos e preparos). Quem imprime: qualquer perfil.
// Quem cadastra produtos e prazos: dono ou gerente.

const uuid = z.string().uuid();
const storageEnum = z.enum(['chilled', 'frozen', 'ambient']);
const hours = z.number().int().min(1).max(87600).nullable().default(null);
const STORAGE_COLUMN = { chilled: 'chilled_hours', frozen: 'frozen_hours', ambient: 'ambient_hours' } as const;
const MAX_LOOKAHEAD_DAYS = 3650;

const productBody = z
  .object({
    name: z.string().trim().min(1).max(60),
    groupName: z.string().trim().max(40).default(''),
    chilledHours: hours,
    frozenHours: hours,
    ambientHours: hours,
    defaultStorage: storageEnum.default('chilled'),
    notes: z.string().trim().max(60).default(''),
    active: z.boolean().default(true),
  })
  .superRefine((p, ctx) => {
    if (p.chilledHours == null && p.frozenHours == null && p.ambientHours == null) {
      ctx.addIssue({ code: 'custom', path: ['chilledHours'], message: 'Informe a validade de pelo menos uma conservação.' });
    }
    const key = { chilled: 'chilledHours', frozen: 'frozenHours', ambient: 'ambientHours' }[p.defaultStorage] as 'chilledHours';
    if (p[key] == null) ctx.addIssue({ code: 'custom', path: ['defaultStorage'], message: 'A conservação padrão precisa ter validade.' });
  });

const printBody = z.object({
  productId: uuid.nullable().default(null),
  productName: z.string().trim().max(60).default(''),
  labelType: z.enum(['handled', 'opened', 'thawing', 'sample']).default('handled'),
  storage: storageEnum,
  handledAt: z.string().datetime({ offset: true }),
  // Validade digitada à mão: obrigatória sem produto cadastrado; com produto, substitui o prazo
  // (ex.: produto aberto cuja embalagem vence antes do prazo padrão).
  manualExpiresAt: z.string().datetime({ offset: true }).nullable().default(null),
  responsible: z.string().trim().min(2).max(40),
  quantityText: z.string().trim().max(20).default(''),
  extra: z.string().trim().max(40).default(''),
  copies: z.number().int().min(1).max(50).default(1),
  // browser: o navegador imprime (impressora de etiqueta 50x30). agent: vai para a fila da Epson do caixa.
  target: z.enum(['browser', 'agent']).default('browser'),
});

const labelForAgent = (r: any, notes: string) => ({
  productName: r.product_name, labelType: r.label_type, storage: r.storage, handledAt: r.handled_at.toISOString(),
  expiresAt: r.expires_at.toISOString(), responsible: r.responsible, lot: r.lot, quantityText: r.quantity_text, extra: r.extra, notes,
});

const productRow = (r: any) => ({
  id: r.id, name: r.name, groupName: r.group_name, chilledHours: r.chilled_hours, frozenHours: r.frozen_hours,
  ambientHours: r.ambient_hours, defaultStorage: r.default_storage, notes: r.notes, active: r.active,
});

export const printRow = (r: any) => ({
  id: r.id, productId: r.product_id, productName: r.product_name, labelType: r.label_type, storage: r.storage,
  handledAt: r.handled_at.toISOString(), expiresAt: r.expires_at.toISOString(), responsible: r.responsible, lot: r.lot,
  quantityText: r.quantity_text, extra: r.extra, copies: r.copies, status: r.status,
  closedAt: r.closed_at ? r.closed_at.toISOString() : null, closeReason: r.close_reason, printedByName: r.printed_by_name ?? null,
  createdAt: r.created_at.toISOString(),
});

export async function adminLabelRoutes(app: FastifyInstance) {
  const managers = { preHandler: requireRole('owner', 'manager') };
  const actor = (req: any) => ({ storeId: req.admin.storeId, userId: req.admin.userId, ip: req.ip });

  // Produtos de etiqueta + dados fixos da etiqueta + nomes de responsáveis já usados (sugestão no campo).
  app.get('/labels/products', async (req) => {
    const storeId = req.admin!.storeId;
    const [products, store, people] = await Promise.all([
      pool.query('SELECT * FROM label_products WHERE store_id = $1 ORDER BY active DESC, group_name, name', [storeId]),
      pool.query('SELECT display_name, timezone FROM store_settings WHERE store_id = $1', [storeId]),
      pool.query(
        `SELECT responsible FROM label_prints WHERE store_id = $1 AND created_at > now() - interval '90 days'
          GROUP BY responsible ORDER BY max(created_at) DESC LIMIT 20`,
        [storeId],
      ),
    ]);
    return {
      products: products.rows.map(productRow),
      store: { name: store.rows[0]?.display_name ?? '', timezone: store.rows[0]?.timezone ?? 'America/Sao_Paulo' },
      responsibles: people.rows.map((r) => r.responsible),
    };
  });

  app.post('/labels/products', managers, async (req) => {
    const b = parse(productBody, req.body);
    return tx(async (db) => {
      try {
        const r = await db.query(
          `INSERT INTO label_products (store_id, name, group_name, chilled_hours, frozen_hours, ambient_hours, default_storage, notes, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [req.admin!.storeId, b.name, b.groupName, b.chilledHours, b.frozenHours, b.ambientHours, b.defaultStorage, b.notes, b.active],
        );
        await audit(db, actor(req), 'label_product.create', 'label_product', r.rows[0].id, { name: b.name });
        return { product: productRow(r.rows[0]) };
      } catch (e: any) {
        if (e.code === '23505') throw badRequest('duplicate_name', 'Já existe um produto de etiqueta com esse nome.');
        throw e;
      }
    });
  });

  app.put<{ Params: { id: string } }>('/labels/products/:id', managers, async (req) => {
    const id = parse(uuid, req.params.id);
    const b = parse(productBody, req.body);
    return tx(async (db) => {
      try {
        const r = await db.query(
          `UPDATE label_products SET name=$3, group_name=$4, chilled_hours=$5, frozen_hours=$6, ambient_hours=$7,
                  default_storage=$8, notes=$9, active=$10, updated_at=now()
            WHERE id=$1 AND store_id=$2 RETURNING *`,
          [id, req.admin!.storeId, b.name, b.groupName, b.chilledHours, b.frozenHours, b.ambientHours, b.defaultStorage, b.notes, b.active],
        );
        if (!r.rowCount) throw notFound('Produto de etiqueta');
        await audit(db, actor(req), 'label_product.update', 'label_product', id, { name: b.name, active: b.active });
        return { product: productRow(r.rows[0]) };
      } catch (e: any) {
        if (e.code === '23505') throw badRequest('duplicate_name', 'Já existe um produto de etiqueta com esse nome.');
        throw e;
      }
    });
  });

  // Emite etiquetas: o servidor calcula a validade pelo cadastro e gera o lote (AAMMDD-NNN, sequência do dia).
  app.post('/labels/prints', async (req) => {
    const b = parse(printBody, req.body);
    const storeId = req.admin!.storeId;
    const handledAt = new Date(b.handledAt);
    const now = Date.now();
    if (handledAt.getTime() > now + 24 * 3600_000) throw badRequest('handled_in_future', 'A data de manipulação está no futuro.');
    if (handledAt.getTime() < now - 365 * 24 * 3600_000) throw badRequest('handled_too_old', 'A data de manipulação está muito antiga.');

    const out = await tx(async (db) => {
      let productNotes = '';
      let productName = b.productName;
      let productId: string | null = null;
      let expiresAt: Date | null = null;
      if (b.productId) {
        const p = (await db.query('SELECT * FROM label_products WHERE id = $1 AND store_id = $2', [b.productId, storeId])).rows[0];
        if (!p) throw notFound('Produto de etiqueta');
        productId = p.id;
        productName = p.name;
        productNotes = p.notes;
        const h = p[STORAGE_COLUMN[b.storage]] as number | null;
        if (h != null) expiresAt = new Date(handledAt.getTime() + h * 3600_000);
      }
      if (!productName) throw badRequest('missing_product', 'Escolha um produto ou digite o nome.');
      if (b.manualExpiresAt) expiresAt = new Date(b.manualExpiresAt);
      if (!expiresAt) {
        throw badRequest('missing_expiry', b.productId ? 'Esse produto não tem validade para essa conservação. Informe a validade.' : 'Informe a validade.');
      }
      if (expiresAt.getTime() <= handledAt.getTime()) throw badRequest('expiry_before_handled', 'A validade precisa ser depois da manipulação.');
      if (expiresAt.getTime() > handledAt.getTime() + MAX_LOOKAHEAD_DAYS * 24 * 3600_000) throw badRequest('expiry_too_far', 'Validade longe demais. Confira a data.');

      // Lote do dia no fuso da loja; a trava evita dois lotes iguais em emissões simultâneas.
      await db.query(`SELECT pg_advisory_xact_lock(hashtext('label_lot:' || $1))`, [storeId]);
      const day = (await db.query(
        `SELECT to_char(now() AT TIME ZONE (SELECT timezone FROM store_settings WHERE store_id = $1), 'YYMMDD') AS d`, [storeId],
      )).rows[0].d as string;
      const seq = (await db.query(
        `SELECT coalesce(max(substring(lot from 8)::int), 0) + 1 AS n FROM label_prints WHERE store_id = $1 AND lot LIKE $2 || '-%'`,
        [storeId, day],
      )).rows[0].n as number;
      const lot = `${day}-${String(seq).padStart(3, '0')}`;

      const r = await db.query(
        `INSERT INTO label_prints (store_id, product_id, product_name, label_type, storage, handled_at, expires_at, responsible, lot,
                                   quantity_text, extra, copies, printed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [storeId, productId, productName, b.labelType, b.storage, handledAt, expiresAt, b.responsible, lot, b.quantityText, b.extra, b.copies, req.admin!.userId],
      );
      let jobId: string | null = null;
      if (b.target === 'agent') {
        jobId = (await createLabelPrintJob(db, storeId, labelForAgent(r.rows[0], productNotes), b.copies, req.admin!.userId)).id;
        await db.query('UPDATE label_prints SET print_job_id = $2 WHERE id = $1', [r.rows[0].id, jobId]);
      }
      await audit(db, actor(req), 'label.print', 'label_print', r.rows[0].id, { product: productName, lot, copies: b.copies, target: b.target });
      return { print: printRow({ ...r.rows[0], printed_by_name: req.admin!.name }), jobId };
    });
    if (out.jobId) emitStoreEvent(storeId, { type: 'print.queued', jobId: out.jobId });
    return out;
  });

  // Reimpressão pela Epson (agente), mesmo lote. Pelo navegador a reimpressão não passa pelo servidor.
  app.post<{ Params: { id: string } }>('/labels/prints/:id/agent', async (req) => {
    const id = parse(uuid, req.params.id);
    const b = parse(z.object({ copies: z.number().int().min(1).max(50).default(1) }), req.body ?? {});
    const storeId = req.admin!.storeId;
    const jobId = await tx(async (db) => {
      const r = (await db.query(
        `SELECT lp.*, coalesce(p.notes, '') AS product_notes FROM label_prints lp LEFT JOIN label_products p ON p.id = lp.product_id
          WHERE lp.id = $1 AND lp.store_id = $2`,
        [id, storeId],
      )).rows[0];
      if (!r) throw notFound('Etiqueta');
      const job = await createLabelPrintJob(db, storeId, labelForAgent(r, r.product_notes), b.copies, req.admin!.userId);
      await audit(db, actor(req), 'label.reprint', 'label_print', id, { lot: r.lot, copies: b.copies });
      return job.id;
    });
    emitStoreEvent(storeId, { type: 'print.queued', jobId });
    return { jobId };
  });

  // Histórico e controle de vencimento. status=active mostra o que ainda está no estoque, do que vence antes.
  app.get('/labels/prints', async (req) => {
    const q = parse(
      z.object({
        status: z.enum(['active', 'all']).default('active'),
        q: z.string().trim().max(60).default(''),
        before: z.string().datetime({ offset: true }).optional(),
      }),
      req.query,
    );
    const storeId = req.admin!.storeId;
    const params: unknown[] = [storeId];
    const where = ['lp.store_id = $1'];
    if (q.status === 'active') where.push(`lp.status = 'active'`);
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(lp.product_name ILIKE $${params.length} OR lp.lot ILIKE $${params.length} OR lp.responsible ILIKE $${params.length})`);
    }
    if (q.before) {
      params.push(q.before);
      where.push(`lp.created_at < $${params.length}`);
    }
    const order = q.status === 'active' ? 'lp.expires_at ASC, lp.created_at DESC' : 'lp.created_at DESC';
    const [rows, summary] = await Promise.all([
      pool.query(
        `SELECT lp.*, u.name AS printed_by_name FROM label_prints lp LEFT JOIN admin_users u ON u.id = lp.printed_by
          WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 100`,
        params,
      ),
      pool.query(
        `SELECT count(*) FILTER (WHERE expires_at <= now())::int AS expired,
                count(*) FILTER (WHERE expires_at > now() AND expires_at <= now() + interval '24 hours')::int AS expiring,
                count(*)::int AS active
           FROM label_prints WHERE store_id = $1 AND status = 'active'`,
        [storeId],
      ),
    ]);
    return { prints: rows.rows.map(printRow), summary: summary.rows[0] };
  });

  // Baixa: o item foi usado ou descartado (descarte fica registrado como perda, com motivo).
  app.post<{ Params: { id: string } }>('/labels/prints/:id/close', async (req) => {
    const id = parse(uuid, req.params.id);
    const b = parse(z.object({ status: z.enum(['used', 'discarded']), reason: z.string().trim().max(200).default('') }), req.body);
    if (b.status === 'discarded' && !b.reason) throw badRequest('missing_reason', 'Informe o motivo do descarte.');
    return tx(async (db) => {
      const r = await db.query(
        `UPDATE label_prints SET status = $3, close_reason = $4, closed_at = now(), closed_by = $5
          WHERE id = $1 AND store_id = $2 AND status = 'active' RETURNING *`,
        [id, req.admin!.storeId, b.status, b.reason, req.admin!.userId],
      );
      if (!r.rowCount) throw notFound('Etiqueta ativa');
      await audit(db, actor(req), `label.${b.status}`, 'label_print', id, { lot: r.rows[0].lot, reason: b.reason });
      return { print: printRow(r.rows[0]) };
    });
  });
}
