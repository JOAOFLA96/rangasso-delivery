import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { emitStoreEvent } from '../lib/events.js';
import { hashIp } from '../lib/security.js';
import { parse } from '../lib/validate.js';
import { notFound } from '../lib/errors.js';
import { imageUrl, publicMenu } from '../services/menu.js';
import { createOrder, createOrderSchema, getOrderDetail, quote, STATUS_LABELS, PAYMENT_LABELS } from '../services/orders.js';
import { currentStoreId, getOpenState, getSettings } from '../services/store.js';
import { WEEKDAY_NAMES_PT } from '../services/storeHours.js';

export async function publicRoutes(app: FastifyInstance) {
  app.get('/store', async () => {
    const storeId = await currentStoreId();
    const s = await getSettings(pool, storeId);
    const state = await getOpenState(pool, storeId, s);
    const hoods = await pool.query(
      `SELECT id, name, city, fee_cents, min_order_cents, fee_pending FROM neighborhoods WHERE store_id = $1 AND active ORDER BY sort_order, name`,
      [storeId],
    );
    const hours = await pool.query(
      `SELECT weekday, to_char(opens_at,'HH24:MI') AS opens_at, to_char(closes_at,'HH24:MI') AS closes_at
         FROM opening_hours WHERE store_id = $1 ORDER BY weekday, opens_at`,
      [storeId],
    );
    return {
      name: s.display_name,
      tagline: s.tagline,
      logoUrl: imageUrl(s.logo_path),
      phone: s.phone,
      whatsapp: s.whatsapp,
      address: s.address,
      menuMessage: s.menu_message,
      deliveryInstructions: s.delivery_instructions,
      privacyContact: s.privacy_contact,
      minOrderCents: s.min_order_cents,
      eta: { min: s.eta_min_minutes, max: s.eta_max_minutes },
      payments: { cash: s.accepts_cash, pix: s.accepts_pix, card: s.accepts_card, pixInstructions: s.pix_instructions },
      open: state.open,
      closedMessage: state.open ? null : s.closed_message,
      nextOpening: state.nextOpening,
      hours: hours.rows.map((h) => ({ weekday: h.weekday, day: WEEKDAY_NAMES_PT[h.weekday], opensAt: h.opens_at, closesAt: h.closes_at })),
      neighborhoods: hoods.rows.map((n) => ({ id: n.id, name: n.name, city: n.city, feeCents: n.fee_cents, minOrderCents: n.min_order_cents, feePending: n.fee_pending })),
      acceptUnlistedNeighborhoods: s.accept_unlisted_neighborhoods,
      deliveryFeeMode: s.delivery_fee_mode === 'distance' && s.store_lat != null ? 'distance' : 'neighborhood',
    };
  });

  app.get('/menu', async (_req, reply) => {
    const storeId = await currentStoreId();
    reply.header('cache-control', 'no-store');
    return { categories: await publicMenu(pool, storeId) };
  });

  app.post('/quote', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(
      z.object({
        items: createOrderSchema.shape.items,
        neighborhoodId: z.string().uuid().nullable().optional(),
        neighborhoodName: z.string().trim().max(80).nullable().optional(),
        city: z.string().trim().max(80).nullable().optional(),
        // Endereço para a taxa por km (opcional; sem ele vale a taxa do bairro).
        address: z.object({
          street: z.string().trim().max(120), number: z.string().trim().max(15), city: z.string().trim().max(80),
          state: z.string().trim().max(30).optional().default(''), cep: z.string().max(12).optional().default(''),
        }).nullable().optional(),
      }),
      req.body,
    );
    const addr = body.address && body.address.street.length >= 2 && body.address.city ? body.address : null;
    return quote(pool, await currentStoreId(), body.items, { id: body.neighborhoodId, name: body.neighborhoodName, city: body.city }, addr);
  });

  app.post('/orders', { config: { rateLimit: { max: config.ORDER_RATE_LIMIT, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const input = parse(createOrderSchema, req.body);
    const storeId = await currentStoreId();
    const { order, created } = await createOrder(input, storeId, hashIp(req.ip));
    if (created) {
      emitStoreEvent(storeId, { type: 'order.created', orderId: order.id, number: order.number });
      emitStoreEvent(storeId, { type: 'print.queued', jobId: '' });
    }
    reply.code(created ? 201 : 200);
    return { number: order.number, token: order.public_token, totalCents: order.total_cents, duplicate: !created };
  });

  // Acompanhamento pelo cliente: acesso só com o token aleatório do pedido.
  app.get<{ Params: { token: string } }>('/orders/:token', async (req, reply) => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(req.params.token)) throw notFound('Pedido');
    const storeId = await currentStoreId();
    const r = await pool.query('SELECT id FROM orders WHERE public_token = $1 AND store_id = $2', [req.params.token, storeId]);
    if (!r.rows[0]) throw notFound('Pedido');
    const o = await getOrderDetail(pool, storeId, r.rows[0].id);
    reply.header('cache-control', 'no-store');
    return {
      number: o.number,
      status: o.status,
      statusLabel: STATUS_LABELS[o.status as keyof typeof STATUS_LABELS],
      createdAt: o.created_at,
      customerName: o.customer_name,
      address: `${o.street}, ${o.street_number}${o.complement ? ` - ${o.complement}` : ''} - ${o.neighborhood_name}`,
      items: o.items.map((i: any) => ({
        quantity: i.quantity, name: i.product_name, lineTotalCents: i.line_total_cents, notes: i.notes,
        addons: i.addons.map((a: any) => a.addon_name),
      })),
      subtotalCents: o.subtotal_cents,
      deliveryFeeCents: o.delivery_fee_cents,
      deliveryFeePending: o.delivery_fee_pending,
      deliveryDistanceKm: o.delivery_distance_km == null ? null : Number(o.delivery_distance_km),
      discountCents: o.discount_cents,
      totalCents: o.total_cents,
      payment: PAYMENT_LABELS[o.payment_method],
      changeForCents: o.change_for_cents,
      cancelReason: o.status === 'cancelled' ? o.cancel_reason : null,
    };
  });
}
