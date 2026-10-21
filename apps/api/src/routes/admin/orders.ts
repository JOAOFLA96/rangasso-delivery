import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { emitStoreEvent, onStoreEvent } from '../../lib/events.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { onlyDigits } from '../../lib/text.js';
import { parse } from '../../lib/validate.js';
import { requireRole } from '../../auth.js';
import { ORDER_STATUSES, changeStatus, getOrderDetail } from '../../services/orders.js';
import { createPrintJob, resolveJob } from '../../services/print.js';

const listQuery = z.object({
  q: z.string().max(80).optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  printStatus: z.enum(['not_queued', 'pending', 'claimed', 'sending', 'sent', 'printed', 'failed', 'uncertain']).optional(),
  payment: z.enum(['cash', 'pix', 'card']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  active: z.enum(['1', '0']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function adminOrderRoutes(app: FastifyInstance) {
  app.get('/orders', async (req) => {
    const q = parse(listQuery, req.query);
    const storeId = req.admin!.storeId;
    const where = ['o.store_id = $1'];
    const params: unknown[] = [storeId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.q) {
      const term = q.q.trim();
      const digits = onlyDigits(term);
      if (/^#?\d{1,6}$/.test(term)) add('o.number = ?', Number(digits));
      else if (digits.length >= 4 && digits.length === term.replace(/[\s()+-]/g, '').length) add("o.customer_phone LIKE '%' || ? || '%'", digits);
      else add("o.customer_name ILIKE '%' || ? || '%'", term);
    }
    if (q.status) add('o.status = ?', q.status);
    if (q.active === '1') where.push(`o.status NOT IN ('completed','cancelled')`);
    if (q.printStatus) add('o.print_status = ?', q.printStatus);
    if (q.payment) add('o.payment_method = ?', q.payment);
    // Datas no fuso da loja.
    if (q.from) add(`o.created_at >= (?::date)::timestamp AT TIME ZONE (SELECT timezone FROM store_settings WHERE store_id = $1)`, q.from);
    if (q.to) add(`o.created_at < ((?::date) + 1)::timestamp AT TIME ZONE (SELECT timezone FROM store_settings WHERE store_id = $1)`, q.to);
    params.push(q.limit, q.offset);
    const rows = await pool.query(
      `SELECT o.id, o.number, o.status, o.print_status, o.customer_name, o.customer_phone, o.neighborhood_name, o.street, o.street_number,
              o.complement, o.payment_method, o.change_for_cents, o.subtotal_cents, o.delivery_fee_cents, o.discount_cents, o.total_cents,
              o.created_at, o.updated_at, o.notes,
              (SELECT coalesce(sum(quantity),0)::int FROM order_items WHERE order_id = o.id) AS item_count,
              count(*) OVER()::int AS total_count
         FROM orders o WHERE ${where.join(' AND ')}
        ORDER BY o.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { total: rows.rows[0]?.total_count ?? 0, orders: rows.rows.map(({ total_count, ...r }) => r) };
  });

  app.get<{ Params: { id: string } }>('/orders/:id', async (req) => {
    const storeId = req.admin!.storeId;
    const id = parse(z.string().uuid(), req.params.id);
    const order = await getOrderDetail(pool, storeId, id);
    const history = await pool.query(
      `SELECT h.from_status, h.to_status, h.note, h.created_at, u.name AS user_name
         FROM order_status_history h LEFT JOIN admin_users u ON u.id = h.changed_by
        WHERE h.order_id = $1 ORDER BY h.created_at`,
      [id],
    );
    const jobs = await pool.query(
      `SELECT j.id, j.kind, j.reprint_number, j.status, j.attempts, j.max_attempts, j.next_attempt_at, j.last_error, j.reason,
              j.created_at, j.sent_at, j.printed_at, u.name AS requested_by_name, d.name AS device_name
         FROM print_jobs j LEFT JOIN admin_users u ON u.id = j.requested_by LEFT JOIN print_devices d ON d.id = j.device_id
        WHERE j.order_id = $1 ORDER BY j.created_at`,
      [id],
    );
    return { order, history: history.rows, printJobs: jobs.rows };
  });

  app.post<{ Params: { id: string } }>('/orders/:id/status', async (req) => {
    const admin = req.admin!;
    const id = parse(z.string().uuid(), req.params.id);
    const body = parse(z.object({ status: z.enum(ORDER_STATUSES), note: z.string().max(300).default('') }), req.body);
    if (body.status === 'cancelled' && admin.role === 'staff') throw badRequest('forbidden_cancel', 'Somente gerente ou dono pode cancelar pedidos.');
    const r = await tx(async (db) => {
      const res = await changeStatus(db, admin.storeId, id, body.status, admin.userId, body.note);
      await audit(db, { storeId: admin.storeId, userId: admin.userId, ip: req.ip }, 'order.status', 'order', id, { from: res.from, to: body.status, note: body.note });
      return res;
    });
    emitStoreEvent(admin.storeId, { type: 'order.updated', orderId: id, number: r.number });
    return { ok: true };
  });

  // Primeira impressão manual (quando a impressão automática está desligada) ou reimpressão.
  app.post<{ Params: { id: string } }>('/orders/:id/print', async (req) => {
    const admin = req.admin!;
    const id = parse(z.string().uuid(), req.params.id);
    const body = parse(z.object({ reason: z.string().max(200).default('') }), req.body ?? {});
    const job = await tx(async (db) => {
      const o = await db.query('SELECT id, number FROM orders WHERE id = $1 AND store_id = $2 FOR UPDATE', [id, admin.storeId]);
      if (!o.rows[0]) throw notFound('Pedido');
      const hasOriginal = await db.query(`SELECT 1 FROM print_jobs WHERE order_id = $1 AND kind = 'original'`, [id]);
      const kind = hasOriginal.rowCount ? 'reprint' : 'original';
      const j = await createPrintJob(db, admin.storeId, { orderId: id, kind, requestedBy: admin.userId, reason: body.reason });
      await audit(db, { storeId: admin.storeId, userId: admin.userId, ip: req.ip }, kind === 'reprint' ? 'print.reprint' : 'print.manual', 'order', id, { jobId: j.id, reason: body.reason });
      return { ...j, number: o.rows[0].number };
    });
    emitStoreEvent(admin.storeId, { type: 'print.queued', jobId: job.id });
    emitStoreEvent(admin.storeId, { type: 'order.updated', orderId: id, number: job.number });
    return { jobId: job.id, kind: job.kind, reprintNumber: job.reprint_number };
  });

  app.post<{ Params: { id: string } }>('/print-jobs/:id/resolve', { preHandler: requireRole('owner', 'manager', 'staff') }, async (req) => {
    const admin = req.admin!;
    const id = parse(z.string().uuid(), req.params.id);
    const body = parse(z.object({ action: z.enum(['retry', 'mark_printed', 'cancel']) }), req.body);
    const job = await tx(async (db) => {
      const j = await resolveJob(db, admin.storeId, id, body.action, admin.userId);
      await audit(db, { storeId: admin.storeId, userId: admin.userId, ip: req.ip }, `print.${body.action}`, 'print_job', id);
      return j;
    });
    emitStoreEvent(admin.storeId, { type: 'print.updated', jobId: id, orderId: job.order_id });
    if (body.action === 'retry') emitStoreEvent(admin.storeId, { type: 'print.queued', jobId: id });
    return { ok: true };
  });

  // Tempo real via Server-Sent Events. O cliente reconecta sozinho (EventSource) e recarrega a lista ao reconectar.
  app.get('/events', async (req, reply) => {
    const storeId = req.admin!.storeId;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 3000\nevent: hello\ndata: {}\n\n`);
    const off = onStoreEvent(storeId, (ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
    const ping = setInterval(() => res.write(`: ping\n\n`), 20_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      off();
    });
  });
}
