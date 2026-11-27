import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { emitStoreEvent } from '../lib/events.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { claimOrder, departRun, finishRun, listRuns, stopOutcome } from '../services/deliveryRuns.js';
import { notifyOrder, pushForStatus } from '../services/push.js';

// Página do motoboy (/motoboy/<link pessoal>): sem senha, o link é a credencial (como o link de acompanhamento do cliente).
// Ele só enxerga e mexe nas saídas dele. A loja troca o link no painel se ele vazar ou o motoboy sair.

const uuid = z.string().uuid();
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{20,64}$/);
// Motivos prontos para não entrega (o motoboy escolhe com um toque).
export const NOT_DELIVERED_REASONS = ['Cliente não atendeu', 'Endereço não encontrado', 'Cliente recusou', 'Cliente pediu para voltar depois', 'Problema com o pedido'];

async function courierOf(req: FastifyRequest<{ Params: { token: string } }>) {
  const token = parse(tokenSchema, req.params.token);
  const c = (await pool.query('SELECT id, store_id, name, active FROM couriers WHERE access_token = $1', [token])).rows[0];
  if (!c || !c.active) throw notFound('Link do motoboy');
  return c as { id: string; store_id: string; name: string };
}

async function ownRun(courierId: string, storeId: string, runId: string) {
  const r = (await pool.query('SELECT id FROM delivery_runs WHERE id = $1 AND store_id = $2 AND courier_id = $3', [runId, storeId, courierId])).rows[0];
  if (!r) throw notFound('Saída');
}

export async function courierRoutes(app: FastifyInstance) {
  const actor = (c: { store_id: string }, req: FastifyRequest) => ({ storeId: c.store_id, userId: null, ip: req.ip });

  app.get<{ Params: { token: string } }>('/:token', async (req, reply) => {
    const c = await courierOf(req);
    reply.header('cache-control', 'no-store');
    const runs = await listRuns(pool, c.store_id, `r.courier_id = $2 AND r.status IN ('planned','out')`, [c.id]);
    const tz = `(SELECT timezone FROM store_settings WHERE store_id = $1)`;
    // Prestação de contas do dia: dinheiro recebido nas entregas dele (o troco já sai do valor pago pelo cliente).
    const day = (await pool.query(
      `SELECT count(*) FILTER (WHERE s.outcome = 'delivered')::int AS delivered,
              count(*) FILTER (WHERE s.outcome = 'not_delivered')::int AS not_delivered,
              coalesce(sum(o.total_cents) FILTER (WHERE s.outcome = 'delivered' AND o.payment_method = 'cash'), 0)::int AS cash_cents,
              coalesce(sum(o.total_cents) FILTER (WHERE s.outcome = 'delivered' AND o.payment_method = 'card'), 0)::int AS card_cents,
              coalesce(sum(o.total_cents) FILTER (WHERE s.outcome = 'delivered' AND o.payment_method = 'pix'), 0)::int AS pix_cents,
              coalesce(sum(o.delivery_fee_cents) FILTER (WHERE s.outcome = 'delivered'), 0)::int AS fees_cents,
              (SELECT count(*) FROM delivery_runs r2 WHERE r2.courier_id = $2 AND r2.departed_at IS NOT NULL
                 AND (r2.departed_at AT TIME ZONE ${tz})::date = (now() AT TIME ZONE ${tz})::date)::int AS runs
         FROM delivery_run_stops s JOIN delivery_runs r ON r.id = s.run_id JOIN orders o ON o.id = s.order_id
        WHERE r.store_id = $1 AND r.courier_id = $2 AND (s.outcome_at AT TIME ZONE ${tz})::date = (now() AT TIME ZONE ${tz})::date`,
      [c.store_id, c.id],
    )).rows[0];
    const store = (await pool.query('SELECT display_name, phone FROM store_settings WHERE store_id = $1', [c.store_id])).rows[0];
    return { courier: { name: c.name }, store: { name: store?.display_name ?? '', phone: store?.phone ?? '' }, runs, today: day, reasons: NOT_DELIVERED_REASONS };
  });

  app.post<{ Params: { token: string; runId: string } }>('/:token/runs/:runId/depart', async (req) => {
    const c = await courierOf(req);
    const runId = parse(uuid, req.params.runId);
    await ownRun(c.id, c.store_id, runId);
    const r = await tx(async (db) => {
      const res = await departRun(db, c.store_id, runId, null);
      await audit(db, actor(c, req), 'delivery_run.depart', 'delivery_run', runId, { number: res.number, by: 'courier', courier: c.name });
      return res;
    });
    emitStoreEvent(c.store_id, { type: 'run.updated', runId });
    for (const o of r.changed) {
      emitStoreEvent(c.store_id, { type: 'order.updated', orderId: o.orderId, number: o.number });
      await push(req, o.orderId, o.number, o.from, 'out_for_delivery');
    }
    return { ok: true };
  });

  app.post<{ Params: { token: string; runId: string; orderId: string } }>('/:token/runs/:runId/stops/:orderId', async (req) => {
    const c = await courierOf(req);
    const runId = parse(uuid, req.params.runId);
    const orderId = parse(uuid, req.params.orderId);
    const b = parse(z.object({ outcome: z.enum(['delivered', 'not_delivered']), note: z.string().max(200).default('') }), req.body);
    await ownRun(c.id, c.store_id, runId);
    const r = await tx(async (db) => {
      const res = await stopOutcome(db, c.store_id, runId, orderId, b.outcome, b.note, null, 'courier');
      await audit(db, actor(c, req), `delivery_run.${b.outcome}`, 'order', orderId, { run: runId, note: b.note, by: 'courier', courier: c.name });
      return res;
    });
    emitStoreEvent(c.store_id, { type: 'run.updated', runId });
    emitStoreEvent(c.store_id, { type: 'order.updated', orderId, number: r.number });
    if (r.changed) await push(req, orderId, r.number, r.changed.from, 'completed');
    return { ok: true };
  });

  // QR do cupom (ou número digitado): o pedido entra na saída dele e a rota é refeita.
  app.post<{ Params: { token: string } }>('/:token/claim', async (req) => {
    const c = await courierOf(req);
    const b = parse(z.object({ orderId: uuid.optional(), number: z.coerce.number().int().positive().max(99999999).optional(), confirm: z.boolean().default(false) })
      .refine((v) => v.orderId || v.number, { message: 'Informe o pedido.' }), req.body);
    const r = await claimOrder(tx, pool, c.store_id, c.id, { orderId: b.orderId, number: b.number }, b.confirm);
    if (!r.already) {
      await audit(pool, actor(c, req), 'delivery_run.claim', 'order', r.orderId, { number: r.number, run: r.runId, from: r.from, by: 'courier', courier: c.name });
      emitStoreEvent(c.store_id, { type: 'run.updated', runId: r.runId });
      emitStoreEvent(c.store_id, { type: 'order.updated', orderId: r.orderId, number: r.number });
    }
    return { ok: true, number: r.number, already: r.already, from: r.from };
  });

  // "Estou chegando": aviso no celular do cliente (se ele ativou os avisos) para a marmita não esperar no portão.
  app.post<{ Params: { token: string; runId: string; orderId: string } }>('/:token/runs/:runId/stops/:orderId/arriving', async (req) => {
    const c = await courierOf(req);
    const runId = parse(uuid, req.params.runId);
    const orderId = parse(uuid, req.params.orderId);
    await ownRun(c.id, c.store_id, runId);
    const row = (await pool.query(
      `UPDATE delivery_run_stops s SET arriving_at = now() FROM delivery_runs r, orders o
        WHERE s.run_id = $1 AND s.order_id = $2 AND r.id = s.run_id AND o.id = s.order_id AND r.status = 'out' AND s.outcome IS NULL
        RETURNING o.number, o.public_token`,
      [runId, orderId],
    )).rows[0];
    if (!row) throw badRequest('stop_not_open', 'Essa entrega não está em andamento.');
    notifyOrder(orderId, { title: `Pedido #${row.number} chegando 🛵`, body: `${c.name} está chegando com seu pedido. Fique de olho no portão!`, url: `/cardapio/pedido/${row.public_token}`, tag: `pedido-${row.number}` })
      .catch((e) => req.log.warn({ err: e }, 'falha ao enviar aviso push'));
    emitStoreEvent(c.store_id, { type: 'run.updated', runId });
    return { ok: true };
  });

  // Localização do celular do motoboy, só enquanto a saída dele está na rua. Fora disso o servidor recusa e o celular para de mandar.
  app.post<{ Params: { token: string } }>('/:token/location', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const c = await courierOf(req);
    const b = parse(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().min(0).max(100000).optional() }), req.body);
    const row = (await pool.query(
      `UPDATE couriers k SET last_lat = $2, last_lng = $3, last_accuracy_m = $4, last_location_at = now(), last_location_run_id = r.id
         FROM delivery_runs r WHERE k.id = $1 AND r.courier_id = k.id AND r.store_id = k.store_id AND r.status = 'out'
       RETURNING r.id`,
      [c.id, b.lat, b.lng, b.accuracy == null ? null : Math.round(b.accuracy)],
    )).rows[0];
    if (!row) throw conflict('not_out', 'Você não está em uma saída agora: a localização não é enviada.');
    emitStoreEvent(c.store_id, { type: 'run.updated', runId: row.id });
    return { ok: true };
  });

  app.post<{ Params: { token: string; runId: string } }>('/:token/runs/:runId/finish', async (req) => {
    const c = await courierOf(req);
    const runId = parse(uuid, req.params.runId);
    await ownRun(c.id, c.store_id, runId);
    await tx(async (db) => {
      const r = await finishRun(db, c.store_id, runId);
      await db.query('UPDATE couriers SET last_location_run_id = NULL WHERE id = $1', [c.id]);
      await audit(db, actor(c, req), 'delivery_run.finish', 'delivery_run', runId, { number: r.number, by: 'courier', courier: c.name });
    });
    emitStoreEvent(c.store_id, { type: 'run.updated', runId });
    return { ok: true };
  });
}

async function push(req: FastifyRequest, orderId: string, number: number, from: string, to: string) {
  const row = (await pool.query('SELECT public_token, fulfillment FROM orders WHERE id = $1', [orderId])).rows[0];
  const msg = row && pushForStatus(number, from, to, row.public_token, row.fulfillment);
  if (msg) notifyOrder(orderId, msg).catch((e) => req.log.warn({ err: e }, 'falha ao enviar aviso push'));
}
