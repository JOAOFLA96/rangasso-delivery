import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { emitStoreEvent } from '../lib/events.js';
import { hashIp } from '../lib/security.js';
import { parse } from '../lib/validate.js';
import { notFound } from '../lib/errors.js';
import { imageUrl, publicMenu } from '../services/menu.js';
import { createOrder, createOrderSchema, getOrderDetail, quote, statusLabel, PAYMENT_LABELS } from '../services/orders.js';
import { currentStoreId, getOpenState, getSettings } from '../services/store.js';
import { WEEKDAY_NAMES_PT } from '../services/storeHours.js';
import { savePushSubscription, vapidKeys } from '../services/push.js';
import { processImage, storeImage } from '../lib/uploads.js';
import { AppError, badRequest } from '../lib/errors.js';
import { cleanText } from '../lib/text.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

async function orderByToken(token: string) {
  if (!TOKEN_RE.test(token)) throw notFound('Pedido');
  const storeId = await currentStoreId();
  const r = await pool.query('SELECT id, status FROM orders WHERE public_token = $1 AND store_id = $2', [token, storeId]);
  if (!r.rows[0]) throw notFound('Pedido');
  return { storeId, id: r.rows[0].id as string, status: r.rows[0].status as string };
}

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
      acceptsPickup: s.accepts_pickup,
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
        fulfillment: z.enum(['delivery', 'pickup']).optional().default('delivery'),
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
    return quote(pool, await currentStoreId(), body.items, { id: body.neighborhoodId, name: body.neighborhoodName, city: body.city }, addr, body.fulfillment === 'pickup');
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
    const { storeId, id } = await orderByToken(req.params.token);
    const o = await getOrderDetail(pool, storeId, id);
    const rv = (await pool.query('SELECT rating, comment, photo_path, created_at FROM order_reviews WHERE order_id = $1', [id])).rows[0];
    reply.header('cache-control', 'no-store');
    return {
      number: o.number,
      status: o.status,
      statusLabel: statusLabel(o.status, o.fulfillment),
      fulfillment: o.fulfillment,
      createdAt: o.created_at,
      customerName: o.customer_name,
      address: o.fulfillment === 'pickup' ? null : `${o.street}, ${o.street_number}${o.complement ? ` - ${o.complement}` : ''} - ${o.neighborhood_name}`,
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
      canReview: o.status === 'completed' && !rv,
      review: rv ? { rating: rv.rating, comment: rv.comment, photoUrl: imageUrl(rv.photo_path), createdAt: rv.created_at } : null,
    };
  });

  // Avisos no celular (Web Push): chave pública e inscrição para um pedido.
  app.get('/push/key', async () => ({ publicKey: (await vapidKeys()).publicKey }));

  app.post<{ Params: { token: string } }>('/orders/:token/push', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    const { storeId, id, status } = await orderByToken(req.params.token);
    const sub = parse(
      z.object({
        endpoint: z.string().url().max(1000).refine((u) => u.startsWith('https://'), 'Endereço de aviso inválido.'),
        keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
      }),
      req.body,
    );
    if (status === 'completed' || status === 'cancelled') throw badRequest('order_closed', 'Este pedido já foi encerrado.');
    await savePushSubscription(pool, storeId, id, sub);
    return { ok: true };
  });

  // Avaliação depois da entrega: nota de 1 a 5, comentário e foto opcionais (multipart).
  app.post<{ Params: { token: string } }>('/orders/:token/review', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const { storeId, id, status } = await orderByToken(req.params.token);
    if (status !== 'completed') throw badRequest('not_delivered', 'Você poderá avaliar quando o pedido for entregue.');
    if ((await pool.query('SELECT 1 FROM order_reviews WHERE order_id = $1', [id])).rowCount) throw new AppError(409, 'already_reviewed', 'Este pedido já foi avaliado. Obrigado!');
    const fields: Record<string, string> = {};
    let photo: Buffer | null = null;
    if (req.isMultipart()) {
      for await (const part of req.parts({ limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 5, fieldSize: 2000 } })) {
        if (part.type === 'file') {
          const buf = await part.toBuffer();
          if (part.file.truncated) throw badRequest('file_too_large', 'Foto maior que 8 MB.');
          if (buf.length) photo = buf;
        } else fields[part.fieldname] = String(part.value ?? '');
      }
    } else Object.assign(fields, req.body ?? {});
    const b = parse(z.object({ rating: z.coerce.number().int().min(1).max(5), comment: z.string().max(1000).optional().default('') }), fields);
    const photoPath = photo ? await storeImage('reviews', await processImage(photo, 1200)) : null;
    try {
      await pool.query('INSERT INTO order_reviews (store_id, order_id, rating, comment, photo_path) VALUES ($1,$2,$3,$4,$5)', [storeId, id, b.rating, cleanText(b.comment, 1000), photoPath]);
    } catch (e: any) {
      if (e?.code === '23505') throw new AppError(409, 'already_reviewed', 'Este pedido já foi avaliado. Obrigado!');
      throw e;
    }
    emitStoreEvent(storeId, { type: 'review.created', orderId: id });
    reply.code(201);
    return { ok: true };
  });
}
