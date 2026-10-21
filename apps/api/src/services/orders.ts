import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { tx } from '../db/pool.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { newToken } from '../lib/security.js';
import { cleanText, normalizeCep, normalizePhone } from '../lib/text.js';
import { effectivePrice } from './pricing.js';
import { getOpenState, getSettings } from './store.js';
import { createPrintJob } from './print.js';

export const ORDER_STATUSES = ['received', 'confirmed', 'preparing', 'out_for_delivery', 'completed', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const STATUS_LABELS: Record<OrderStatus, string> = {
  received: 'Recebido',
  confirmed: 'Confirmado',
  preparing: 'Em preparo',
  out_for_delivery: 'Saiu para entrega',
  completed: 'Concluído',
  cancelled: 'Cancelado',
};
export const PAYMENT_LABELS: Record<string, string> = { cash: 'Dinheiro', pix: 'Pix', card: 'Cartão na entrega' };

// Fluxo só anda para frente (pode pular etapas). Cancelamento só a partir de estados não finais.
export function canTransition(from: OrderStatus, to: OrderStatus) {
  if (from === to) return false;
  if (from === 'completed' || from === 'cancelled') return false;
  if (to === 'cancelled') return true;
  return ORDER_STATUSES.indexOf(to) > ORDER_STATUSES.indexOf(from);
}

export const createOrderSchema = z.object({
  idempotencyKey: z.string().min(16).max(80).regex(/^[A-Za-z0-9_-]+$/),
  customer: z.object({ name: z.string().min(2).max(80), phone: z.string().min(8).max(25) }),
  address: z.object({
    cep: z.string().max(12).optional().default(''),
    street: z.string().min(2).max(120),
    number: z.string().min(1).max(15),
    neighborhoodId: z.string().uuid(),
    complement: z.string().max(80).optional().default(''),
    reference: z.string().max(120).optional().default(''),
  }),
  notes: z.string().max(300).optional().default(''),
  payment: z.object({
    method: z.enum(['cash', 'pix', 'card']),
    changeForCents: z.number().int().min(0).max(10_000_00).nullable().optional(),
  }),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().min(1).max(99),
        notes: z.string().max(140).optional().default(''),
        addonIds: z.array(z.string().uuid()).max(30).optional().default([]),
      }),
    )
    .min(1)
    .max(50),
  acceptPrivacy: z.literal(true),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

function requestHash(input: CreateOrderInput) {
  const { idempotencyKey, ...rest } = input;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

export interface PricedItem {
  productId: string;
  productName: string;
  categoryName: string;
  regularPriceCents: number;
  unitPriceCents: number;
  addonsUnitCents: number;
  quantity: number;
  lineTotalCents: number;
  notes: string;
  addons: { addonId: string; groupName: string; addonName: string; priceCents: number }[];
  trackStock: boolean;
}

// Recalcula itens a partir do banco. Lança erro claro se algo estiver indisponível ou inválido.
export async function priceItems(db: Db, storeId: string, items: CreateOrderInput['items'], now = new Date()): Promise<PricedItem[]> {
  const productIds = [...new Set(items.map((i) => i.productId))];
  const prods = await db.query(
    `SELECT p.*, c.name AS category_name, c.active AS cat_active, c.archived_at AS cat_archived
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.store_id = $1 AND p.id = ANY($2::uuid[])`,
    [storeId, productIds],
  );
  const byId = new Map(prods.rows.map((p) => [p.id, p]));
  const groups = await db.query(`SELECT * FROM addon_groups WHERE store_id = $1 AND product_id = ANY($2::uuid[]) AND active`, [storeId, productIds]);
  const groupIds = groups.rows.map((g) => g.id);
  const addons = await db.query(`SELECT * FROM addons WHERE store_id = $1 AND group_id = ANY($2::uuid[]) AND active`, [storeId, groupIds]);
  const addonById = new Map(addons.rows.map((a) => [a.id, a]));

  const qtyByProduct = new Map<string, number>();
  const priced: PricedItem[] = [];
  for (const item of items) {
    const p = byId.get(item.productId);
    if (!p || !p.active || p.archived_at || !p.cat_active || p.cat_archived) {
      throw badRequest('product_unavailable', `Um dos produtos do carrinho não está mais no cardápio. Atualize o carrinho.`, { productId: item.productId });
    }
    if (!p.available) throw badRequest('product_unavailable', `"${p.name}" está indisponível no momento.`, { productId: p.id });
    qtyByProduct.set(p.id, (qtyByProduct.get(p.id) ?? 0) + item.quantity);
    if (p.track_stock && (p.stock_qty ?? 0) < qtyByProduct.get(p.id)!) {
      throw badRequest('out_of_stock', `"${p.name}" tem apenas ${p.stock_qty ?? 0} unidade(s) disponível(is).`, { productId: p.id });
    }

    const productGroups = groups.rows.filter((g) => g.product_id === p.id);
    const chosen = [...new Set(item.addonIds)].map((id) => {
      const a = addonById.get(id);
      const g = a && productGroups.find((x) => x.id === a.group_id);
      if (!a || !g) throw badRequest('invalid_addon', `Adicional inválido para "${p.name}". Atualize o carrinho.`, { productId: p.id });
      if (!a.available) throw badRequest('addon_unavailable', `O adicional "${a.name}" está indisponível.`, { productId: p.id });
      return { a, g };
    });
    for (const g of productGroups) {
      const count = chosen.filter((c) => c.g.id === g.id).length;
      if (count < g.min_select) throw badRequest('addon_required', `Escolha pelo menos ${g.min_select} opção(ões) em "${g.name}" para "${p.name}".`, { productId: p.id });
      if (count > g.max_select) throw badRequest('addon_limit', `Escolha no máximo ${g.max_select} opção(ões) em "${g.name}" para "${p.name}".`, { productId: p.id });
    }
    const unit = effectivePrice(p, now);
    const addonsUnit = chosen.reduce((s, c) => s + c.a.price_cents, 0);
    priced.push({
      productId: p.id,
      productName: p.name,
      categoryName: p.category_name,
      regularPriceCents: p.price_cents,
      unitPriceCents: unit,
      addonsUnitCents: addonsUnit,
      quantity: item.quantity,
      lineTotalCents: (unit + addonsUnit) * item.quantity,
      notes: cleanText(item.notes, 140),
      addons: chosen.map((c) => ({ addonId: c.a.id, groupName: c.g.name, addonName: c.a.name, priceCents: c.a.price_cents })),
      trackStock: p.track_stock,
    });
  }
  return priced;
}

// Prévia usada pelo carrinho (mesma regra do pedido, sem gravar nada).
export async function quote(db: Db, storeId: string, items: CreateOrderInput['items'], neighborhoodId: string | null) {
  const priced = await priceItems(db, storeId, items);
  const settings = await getSettings(db, storeId);
  const subtotal = priced.reduce((s, i) => s + i.lineTotalCents, 0);
  let fee: number | null = null;
  let minOrder = settings.min_order_cents as number;
  if (neighborhoodId) {
    const n = await db.query('SELECT * FROM neighborhoods WHERE id = $1 AND store_id = $2 AND active', [neighborhoodId, storeId]);
    if (!n.rows[0]) throw badRequest('area_not_served', 'Ainda não entregamos nesse bairro.');
    fee = n.rows[0].fee_cents;
    if (n.rows[0].min_order_cents != null) minOrder = Math.max(minOrder, n.rows[0].min_order_cents);
  }
  const savings = priced.reduce((s, i) => s + (i.regularPriceCents - i.unitPriceCents) * i.quantity, 0);
  return {
    items: priced.map(({ trackStock, ...i }) => i),
    subtotalCents: subtotal,
    deliveryFeeCents: fee,
    discountCents: 0,
    totalCents: fee == null ? null : subtotal + fee,
    promoSavingsCents: savings,
    minOrderCents: minOrder,
    belowMinimum: subtotal < minOrder,
  };
}

export async function createOrder(input: CreateOrderInput, storeId: string, ipHash: string | null) {
  const hash = requestHash(input);

  // Idempotência: o mesmo envio (duplo clique, reenvio após timeout) devolve o pedido já criado.
  const existing = await findByIdempotency(storeId, input.idempotencyKey);
  if (existing) {
    if (existing.request_hash !== hash) throw conflict('idempotency_mismatch', 'Este pedido já foi enviado com outros dados. Recarregue a página.');
    return { order: existing, created: false };
  }

  const phone = normalizePhone(input.customer.phone);
  if (!phone) throw badRequest('invalid_phone', 'Telefone inválido. Informe DDD + número.', { field: 'customer.phone' });
  let cep = '';
  if (input.address.cep) {
    const c = normalizeCep(input.address.cep);
    if (!c) throw badRequest('invalid_cep', 'CEP inválido.', { field: 'address.cep' });
    cep = c;
  }

  try {
    return await tx(async (db) => {
      const settings = await getSettings(db, storeId);
      const state = await getOpenState(db, storeId, settings);
      if (!state.open) throw new AppError(409, 'store_closed', settings.closed_message || 'A loja está fechada no momento.');

      const methodEnabled = { cash: settings.accepts_cash, pix: settings.accepts_pix, card: settings.accepts_card }[input.payment.method];
      if (!methodEnabled) throw badRequest('payment_not_accepted', 'Forma de pagamento não aceita no momento.', { field: 'payment.method' });

      const n = await db.query('SELECT * FROM neighborhoods WHERE id = $1 AND store_id = $2', [input.address.neighborhoodId, storeId]);
      const hood = n.rows[0];
      if (!hood || !hood.active) throw badRequest('area_not_served', 'Ainda não entregamos nesse bairro.', { field: 'address.neighborhoodId' });

      const priced = await priceItems(db, storeId, input.items);
      const subtotal = priced.reduce((s, i) => s + i.lineTotalCents, 0);
      const minOrder = Math.max(settings.min_order_cents, hood.min_order_cents ?? 0);
      if (subtotal < minOrder) throw badRequest('below_minimum', `O pedido mínimo é de R$ ${(minOrder / 100).toFixed(2).replace('.', ',')}.`);
      const fee = hood.fee_cents as number;
      const discount = 0;
      const total = subtotal + fee - discount;

      let changeFor: number | null = null;
      if (input.payment.method === 'cash' && input.payment.changeForCents) {
        if (input.payment.changeForCents < total) throw badRequest('invalid_change', 'O valor para troco precisa ser maior ou igual ao total.', { field: 'payment.changeForCents' });
        changeFor = input.payment.changeForCents;
      }

      // Baixa de estoque condicional: falha se outro pedido levou as últimas unidades.
      const qtyByProduct = new Map<string, number>();
      for (const i of priced) if (i.trackStock) qtyByProduct.set(i.productId, (qtyByProduct.get(i.productId) ?? 0) + i.quantity);
      for (const [productId, qty] of qtyByProduct) {
        const r = await db.query('UPDATE products SET stock_qty = stock_qty - $1, updated_at = now() WHERE id = $2 AND stock_qty >= $1', [qty, productId]);
        if (r.rowCount === 0) throw badRequest('out_of_stock', 'Um produto acabou enquanto você finalizava. Revise o carrinho.', { productId });
      }

      const counter = await db.query(
        `INSERT INTO store_counters (store_id, last_order_number) VALUES ($1, 1)
         ON CONFLICT (store_id) DO UPDATE SET last_order_number = store_counters.last_order_number + 1
         RETURNING last_order_number`,
        [storeId],
      );
      const number = counter.rows[0].last_order_number as number;

      const o = await db.query(
        `INSERT INTO orders (store_id, number, public_token, idempotency_key, request_hash, customer_name, customer_phone, cep, street,
            street_number, complement, reference, neighborhood_id, neighborhood_name, city, notes, payment_method, change_for_cents,
            subtotal_cents, delivery_fee_cents, discount_cents, total_cents, customer_ip_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         RETURNING *`,
        [
          storeId, number, newToken(24), input.idempotencyKey, hash, cleanText(input.customer.name, 80), phone, cep,
          cleanText(input.address.street, 120), cleanText(input.address.number, 15), cleanText(input.address.complement, 80),
          cleanText(input.address.reference, 120), hood.id, hood.name, hood.city, cleanText(input.notes, 300),
          input.payment.method, changeFor, subtotal, fee, discount, total, ipHash,
        ],
      );
      const order = o.rows[0];

      for (const [pos, i] of priced.entries()) {
        const it = await db.query(
          `INSERT INTO order_items (order_id, store_id, product_id, product_name, category_name, regular_price_cents, unit_price_cents,
              addons_unit_cents, quantity, line_total_cents, notes, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [order.id, storeId, i.productId, i.productName, i.categoryName, i.regularPriceCents, i.unitPriceCents, i.addonsUnitCents, i.quantity, i.lineTotalCents, i.notes, pos],
        );
        for (const a of i.addons) {
          await db.query(
            `INSERT INTO order_item_addons (order_item_id, addon_id, group_name, addon_name, price_cents) VALUES ($1,$2,$3,$4,$5)`,
            [it.rows[0].id, a.addonId, a.groupName, a.addonName, a.priceCents],
          );
        }
      }
      await db.query(`INSERT INTO order_status_history (order_id, store_id, from_status, to_status, note) VALUES ($1,$2,NULL,'received','Pedido feito pelo cardápio')`, [order.id, storeId]);

      if (settings.auto_print) await createPrintJob(db, storeId, { orderId: order.id, kind: 'original' });

      return { order, created: true };
    });
  } catch (err: any) {
    // Corrida entre dois envios simultâneos com a mesma chave: devolve o que venceu.
    if (err?.code === '23505' && String(err?.constraint).includes('idempotency')) {
      const again = await findByIdempotency(storeId, input.idempotencyKey);
      if (again && again.request_hash === hash) return { order: again, created: false };
    }
    throw err;
  }
}

async function findByIdempotency(storeId: string, key: string) {
  const { pool } = await import('../db/pool.js');
  const r = await pool.query('SELECT * FROM orders WHERE store_id = $1 AND idempotency_key = $2', [storeId, key]);
  return r.rows[0] ?? null;
}

export async function getOrderDetail(db: Db, storeId: string, orderId: string) {
  const o = await db.query('SELECT * FROM orders WHERE id = $1 AND store_id = $2', [orderId, storeId]);
  if (!o.rows[0]) throw notFound('Pedido');
  const items = await db.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY position', [orderId]);
  const addons = await db.query(
    `SELECT a.* FROM order_item_addons a JOIN order_items i ON i.id = a.order_item_id WHERE i.order_id = $1`,
    [orderId],
  );
  return {
    ...o.rows[0],
    items: items.rows.map((i) => ({ ...i, addons: addons.rows.filter((a) => a.order_item_id === i.id) })),
  };
}

export async function changeStatus(
  db: PoolClient,
  storeId: string,
  orderId: string,
  to: OrderStatus,
  userId: string,
  note: string,
) {
  const o = await db.query('SELECT id, number, status FROM orders WHERE id = $1 AND store_id = $2 FOR UPDATE', [orderId, storeId]);
  const order = o.rows[0];
  if (!order) throw notFound('Pedido');
  if (!canTransition(order.status, to)) {
    throw badRequest('invalid_transition', `Não é possível mudar de "${STATUS_LABELS[order.status as OrderStatus]}" para "${STATUS_LABELS[to]}".`);
  }
  if (to === 'cancelled') {
    if (!note.trim()) throw badRequest('reason_required', 'Informe o motivo do cancelamento.');
    // Devolve o estoque dos produtos controlados.
    await db.query(
      `UPDATE products p SET stock_qty = p.stock_qty + s.qty, updated_at = now()
         FROM (SELECT product_id, sum(quantity) AS qty FROM order_items WHERE order_id = $1 GROUP BY product_id) s
        WHERE p.id = s.product_id AND p.track_stock AND p.stock_qty IS NOT NULL`,
      [orderId],
    );
    // Trabalhos de impressão ainda não enviados deixam de fazer sentido.
    await db.query(`UPDATE print_jobs SET status = 'cancelled', updated_at = now() WHERE order_id = $1 AND status IN ('pending','failed')`, [orderId]);
  }
  await db.query(
    `UPDATE orders SET status = $1, cancel_reason = CASE WHEN $1 = 'cancelled' THEN $3 ELSE cancel_reason END, updated_at = now() WHERE id = $2`,
    [to, orderId, note.trim()],
  );
  await db.query(
    `INSERT INTO order_status_history (order_id, store_id, from_status, to_status, changed_by, note) VALUES ($1,$2,$3,$4,$5,$6)`,
    [orderId, storeId, order.status, to, userId, note.trim()],
  );
  return { number: order.number as number, from: order.status as OrderStatus };
}
