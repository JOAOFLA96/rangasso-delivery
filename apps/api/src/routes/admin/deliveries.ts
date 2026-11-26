import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { emitStoreEvent } from '../../lib/events.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { cleanText, normalizePhone } from '../../lib/text.js';
import { parse } from '../../lib/validate.js';
import { requireRole } from '../../auth.js';
import { notifyOrder, pushForStatus } from '../../services/push.js';
import { tripPlannerEnabled } from '../../services/google.js';
import {
  ACTIVE_RUNS_WHERE, AVAILABLE_SQL, MAX_STOPS, cancelRun, createRun, departRun, finishRun, listRuns, stopOutcome, updateRun,
} from '../../services/deliveryRuns.js';

const uuid = z.string().uuid();
const courierBody = z.object({ name: z.string().trim().min(2).max(60), phone: z.string().max(25).default(''), active: z.boolean().default(true) });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function adminDeliveryRoutes(app: FastifyInstance) {
  const actor = (req: any) => ({ storeId: req.admin!.storeId, userId: req.admin!.userId, ip: req.ip });
  const runEvent = (storeId: string, runId: string) => emitStoreEvent(storeId, { type: 'run.updated', runId });

  // ---- Motoboys ----
  app.get('/couriers', async (req) => {
    const r = await pool.query('SELECT id, name, phone, active FROM couriers WHERE store_id = $1 ORDER BY active DESC, lower(name)', [req.admin!.storeId]);
    return { couriers: r.rows };
  });

  const saveCourier = async (req: any, id: string | null) => {
    const b = parse(courierBody, req.body);
    const phone = b.phone.trim() ? normalizePhone(b.phone) : '';
    if (phone === null) throw badRequest('invalid_phone', 'Telefone inválido. Use DDD + número.');
    const storeId = req.admin!.storeId;
    try {
      const r = id
        ? await pool.query('UPDATE couriers SET name = $3, phone = $4, active = $5 WHERE id = $1 AND store_id = $2 RETURNING id', [id, storeId, cleanText(b.name, 60), phone, b.active])
        : await pool.query('INSERT INTO couriers (store_id, name, phone, active) VALUES ($1,$2,$3,$4) RETURNING id', [storeId, cleanText(b.name, 60), phone, b.active]);
      if (!r.rows[0]) throw notFound('Motoboy');
      await audit(pool, actor(req), id ? 'courier.update' : 'courier.create', 'courier', r.rows[0].id, { name: b.name, active: b.active });
      return { id: r.rows[0].id };
    } catch (e: any) {
      if (e.code === '23505') throw conflict('courier_exists', 'Já existe um motoboy com esse nome.');
      throw e;
    }
  };
  app.post('/couriers', { preHandler: requireRole('owner', 'manager') }, (req) => saveCourier(req, null));
  app.put<{ Params: { id: string } }>('/couriers/:id', { preHandler: requireRole('owner', 'manager') }, (req) => saveCourier(req, parse(uuid, req.params.id)));

  // ---- Pedidos prontos para montar rota ----
  app.get('/deliveries/available', async (req) => {
    const r = await pool.query(
      `SELECT o.id, o.number, o.status, o.customer_name, o.street, o.street_number, o.complement, o.neighborhood_name, o.payment_method,
              o.change_for_cents, o.total_cents, o.delivery_distance_km::float AS distance_km, o.created_at, o.print_status,
              (SELECT count(*) FROM delivery_run_stops s WHERE s.order_id = o.id AND s.outcome = 'not_delivered')::int AS failed_attempts
         FROM orders o WHERE o.store_id = $1 AND ${AVAILABLE_SQL} ORDER BY o.created_at`,
      [req.admin!.storeId],
    );
    return { orders: r.rows, maxStops: MAX_STOPS, google: tripPlannerEnabled() };
  });

  // ---- Saídas ----
  app.get('/delivery-runs', async (req) => {
    const q = parse(z.object({ date: day.optional() }), req.query);
    const storeId = req.admin!.storeId;
    // Sem data: as saídas em andamento. Com data: todas as criadas naquele dia (fuso da loja).
    const runs = q.date
      ? await listRuns(pool, storeId, `(r.created_at AT TIME ZONE (SELECT timezone FROM store_settings WHERE store_id = $1))::date = $2::date`, [q.date])
      : await listRuns(pool, storeId, ACTIVE_RUNS_WHERE, []);
    return { runs };
  });

  app.post('/delivery-runs', async (req, reply) => {
    const b = parse(z.object({ courierId: uuid.nullable().default(null), orderIds: z.array(uuid).min(1).max(MAX_STOPS), optimize: z.boolean().default(true) }), req.body);
    const storeId = req.admin!.storeId;
    const r = await createRun(tx, pool, storeId, req.admin!.userId, b);
    await audit(pool, actor(req), 'delivery_run.create', 'delivery_run', r.id, { number: r.number, orders: b.orderIds.length, routeBy: r.routeBy });
    runEvent(storeId, r.id);
    reply.code(201);
    return r;
  });

  app.put<{ Params: { id: string } }>('/delivery-runs/:id', async (req) => {
    const id = parse(uuid, req.params.id);
    const b = parse(z.object({ courierId: uuid.nullable().optional(), orderIds: z.array(uuid).min(1).max(MAX_STOPS).optional(), optimize: z.boolean().default(true) }), req.body);
    const storeId = req.admin!.storeId;
    const r = await updateRun(tx, pool, storeId, id, b);
    await audit(pool, actor(req), 'delivery_run.update', 'delivery_run', id, { courierId: b.courierId, orders: b.orderIds?.length, optimize: b.optimize });
    runEvent(storeId, id);
    return r;
  });

  app.post<{ Params: { id: string } }>('/delivery-runs/:id/cancel', async (req) => {
    const id = parse(uuid, req.params.id);
    const storeId = req.admin!.storeId;
    await tx(async (c) => {
      const r = await cancelRun(c, storeId, id);
      await audit(c, actor(req), 'delivery_run.cancel', 'delivery_run', id, { number: r.number });
    });
    runEvent(storeId, id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/delivery-runs/:id/depart', async (req) => {
    const id = parse(uuid, req.params.id);
    const storeId = req.admin!.storeId;
    const r = await tx(async (c) => {
      const res = await departRun(c, storeId, id, req.admin!.userId);
      await audit(c, actor(req), 'delivery_run.depart', 'delivery_run', id, { number: res.number, orders: res.changed.map((o) => o.number) });
      return res;
    });
    runEvent(storeId, id);
    for (const o of r.changed) {
      emitStoreEvent(storeId, { type: 'order.updated', orderId: o.orderId, number: o.number });
      await sendPush(req, o.orderId, o.number, o.from, 'out_for_delivery');
    }
    return { ok: true, updated: r.changed.length };
  });

  app.post<{ Params: { id: string; orderId: string } }>('/delivery-runs/:id/stops/:orderId', async (req) => {
    const id = parse(uuid, req.params.id);
    const orderId = parse(uuid, req.params.orderId);
    const b = parse(z.object({ outcome: z.enum(['delivered', 'not_delivered']), note: z.string().max(200).default('') }), req.body);
    const storeId = req.admin!.storeId;
    const r = await tx(async (c) => {
      const res = await stopOutcome(c, storeId, id, orderId, b.outcome, b.note, req.admin!.userId);
      await audit(c, actor(req), `delivery_run.${b.outcome}`, 'order', orderId, { run: id, note: b.note });
      return res;
    });
    runEvent(storeId, id);
    emitStoreEvent(storeId, { type: 'order.updated', orderId, number: r.number });
    if (r.changed) await sendPush(req, orderId, r.number, r.changed.from, 'completed');
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/delivery-runs/:id/finish', async (req) => {
    const id = parse(uuid, req.params.id);
    const storeId = req.admin!.storeId;
    await tx(async (c) => {
      const r = await finishRun(c, storeId, id);
      await audit(c, actor(req), 'delivery_run.finish', 'delivery_run', id, { number: r.number });
    });
    runEvent(storeId, id);
    return { ok: true };
  });

  // ---- Resumo por motoboy (tempos e quantidades) ----
  app.get('/delivery-runs/summary', async (req) => {
    const q = parse(z.object({ from: day, to: day }), req.query);
    const storeId = req.admin!.storeId;
    const tz = `(SELECT timezone FROM store_settings WHERE store_id = $1)`;
    const r = await pool.query(
      `WITH runs AS (
         SELECT r.* FROM delivery_runs r
          WHERE r.store_id = $1 AND r.status IN ('out','done') AND r.departed_at IS NOT NULL
            AND r.departed_at >= ($2::date)::timestamp AT TIME ZONE ${tz} AND r.departed_at < (($3::date) + 1)::timestamp AT TIME ZONE ${tz}
       ), stops AS (
         SELECT s.*, r.courier_id, r.departed_at, o.created_at AS order_created_at, o.delivery_fee_cents
           FROM delivery_run_stops s JOIN runs r ON r.id = s.run_id JOIN orders o ON o.id = s.order_id
       )
       SELECT c.id AS courier_id, coalesce(c.name, 'Sem motoboy') AS courier_name,
              (SELECT count(*) FROM runs r WHERE r.courier_id IS NOT DISTINCT FROM c.id)::int AS runs,
              count(*) FILTER (WHERE s.outcome = 'delivered')::int AS delivered,
              count(*) FILTER (WHERE s.outcome = 'not_delivered')::int AS not_delivered,
              coalesce(sum(s.delivery_fee_cents) FILTER (WHERE s.outcome = 'delivered'), 0)::int AS delivery_fees_cents,
              (SELECT coalesce(sum(r.total_distance_m), 0) FROM runs r WHERE r.courier_id IS NOT DISTINCT FROM c.id)::int AS planned_distance_m,
              round(avg(extract(epoch FROM s.outcome_at - s.departed_at) / 60) FILTER (WHERE s.outcome = 'delivered'))::int AS avg_ride_min,
              round(avg(extract(epoch FROM s.outcome_at - s.order_created_at) / 60) FILTER (WHERE s.outcome = 'delivered'))::int AS avg_total_min,
              (SELECT round(avg(extract(epoch FROM r.finished_at - r.departed_at) / 60))::int FROM runs r WHERE r.courier_id IS NOT DISTINCT FROM c.id AND r.finished_at IS NOT NULL) AS avg_cycle_min
         FROM stops s LEFT JOIN couriers c ON c.id = s.courier_id
        GROUP BY c.id, c.name ORDER BY delivered DESC`,
      [storeId, q.from, q.to],
    );
    return { couriers: r.rows };
  });
}

async function sendPush(req: any, orderId: string, number: number, from: string, to: string) {
  const row = (await pool.query('SELECT public_token, fulfillment FROM orders WHERE id = $1', [orderId])).rows[0];
  const msg = row && pushForStatus(number, from, to, row.public_token, row.fulfillment);
  if (msg) notifyOrder(orderId, msg).catch((e) => req.log.warn({ err: e }, 'falha ao enviar aviso push'));
}
