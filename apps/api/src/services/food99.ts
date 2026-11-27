// Integração com o 99Food (Plataforma Aberta, "99Food Protocol").
// Documentação: https://developer-food.99app.com/pt-BR/openapi (Food > 99Food Protocol).
// - Os pedidos chegam por webhook assinado (header didi-header-sign = MD5(corpo cru + app_secret)).
// - Cada loja ligada ao app tem um auth_token próprio, obtido com app_id + app_secret + app_shop_id.
// - O pedido novo precisa ser aceito em até 5 minutos (/v1/order/order/confirm), senão o 99 cancela.
// - IDs de app, loja e pedido têm 64 bits: são lidos e guardados como texto para não perder dígitos.
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import type { Db } from '../db/pool.js';
import { pool, tx } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { newToken, safeEqual } from '../lib/security.js';
import { cleanText, onlyDigits } from '../lib/text.js';
import { createPrintJob } from './print.js';
import { getSettings } from './store.js';

export const food99Enabled = () => !!(config.FOOD99_APP_ID && config.FOOD99_APP_SECRET);

// ---------------------------------------------------------------------------------------------
// JSON com inteiros de 64 bits

// Inteiros grandes demais para o Number do JavaScript voltam como texto exato (usa o texto original do JSON).
export function parseJsonBig(raw: string): any {
  return (JSON.parse as any)(raw, (_k: string, v: unknown, ctx?: { source?: string }) =>
    typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v) && ctx?.source ? ctx.source : v);
}

// Campos de ID vão no JSON como número (o 99 espera long), mesmo guardados como texto aqui.
const BIG = '\u0000BIG:';
export const bigId = (id: string) => `${BIG}${id}`;
export function stringifyBig(body: object) {
  return JSON.stringify(body).replace(/"\\u0000BIG:(\d+)"/g, '$1');
}

// Assinatura dos webhooks: MD5(corpo cru + app_secret), em hexadecimal.
export function webhookSign(raw: string, secret = config.FOOD99_APP_SECRET) {
  return createHash('md5').update(raw + secret, 'utf8').digest('hex');
}
export function verifyWebhook(raw: string, header: string | undefined) {
  if (!header || !config.FOOD99_APP_SECRET) return false;
  return safeEqual(webhookSign(raw).toLowerCase(), header.trim().toLowerCase());
}

// ---------------------------------------------------------------------------------------------
// Cliente da API

export class Food99Error extends Error {
  constructor(public errno: number, message: string, public requestId?: string) {
    super(message);
  }
}
const TOKEN_ERRORS = new Set([10100, 10101, 10102]);

type Fetcher = typeof fetch;
let fetcher: Fetcher = (...a) => fetch(...a);
// Usado nos testes para simular o servidor do 99Food.
export function setFood99Fetch(f: Fetcher | null) {
  fetcher = f ?? ((...a) => fetch(...a));
}

async function call(path: string, opts: { query?: Record<string, string>; body?: object } = {}) {
  const url = new URL(path, config.FOOD99_API_URL);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetcher(url, {
      method: opts.body ? 'POST' : 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      body: opts.body ? stringifyBig(opts.body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e: any) {
    throw new Food99Error(-1, `Sem resposta do 99Food (${e?.name === 'TimeoutError' ? 'tempo esgotado' : 'falha de rede'}).`);
  }
  const text = await res.text();
  let json: any;
  try {
    json = parseJsonBig(text);
  } catch {
    throw new Food99Error(-1, `Resposta inválida do 99Food (HTTP ${res.status}).`);
  }
  if (json?.errno !== 0) throw new Food99Error(Number(json?.errno ?? -1), String(json?.errmsg ?? `HTTP ${res.status}`), json?.requestId);
  return json.data;
}

const credentials = () => ({ app_id: config.FOOD99_APP_ID, app_secret: config.FOOD99_APP_SECRET });

// Token de cada loja: reaproveita enquanto vale (com folga de 2 min); vencido, renova e busca de novo.
const inflight = new Map<string, Promise<string>>();
export async function shopToken(appShopId: string, force = false): Promise<string> {
  if (!force) {
    const r = await pool.query('SELECT auth_token, token_expires_at FROM food99_shops WHERE app_shop_id = $1', [appShopId]);
    const s = r.rows[0];
    if (s?.auth_token && s.token_expires_at && new Date(s.token_expires_at).getTime() > Date.now() + 120_000) return s.auth_token;
  }
  const running = inflight.get(appShopId);
  if (running) return running;
  const p = (async () => {
    const q = { ...credentials(), app_shop_id: appShopId };
    let data: any;
    try {
      data = await call('/v1/auth/authtoken/get', { query: q });
      if (force || (data?.token_expiration_time && data.token_expiration_time * 1000 < Date.now() + 120_000)) throw new Food99Error(10102, 'token vencido');
    } catch (e) {
      if (!(e instanceof Food99Error) || !TOKEN_ERRORS.has(e.errno)) throw e;
      await call('/v1/auth/authtoken/refresh', { query: q });
      data = await call('/v1/auth/authtoken/get', { query: q });
    }
    const expires = data?.token_expiration_time ? new Date(Number(data.token_expiration_time) * 1000) : null;
    await pool.query(
      `UPDATE food99_shops SET auth_token = $2, token_expires_at = $3, last_error = NULL, updated_at = now() WHERE app_shop_id = $1`,
      [appShopId, data.auth_token, expires],
    );
    return data.auth_token as string;
  })();
  inflight.set(appShopId, p);
  try {
    return await p;
  } catch (e: any) {
    await pool.query('UPDATE food99_shops SET last_error = $2, updated_at = now() WHERE app_shop_id = $1', [appShopId, String(e?.message ?? e).slice(0, 300)]);
    throw e;
  } finally {
    inflight.delete(appShopId);
  }
}

// Chama um endpoint da loja; se o 99 disser que o token venceu, renova e tenta de novo uma vez.
async function shopCall(appShopId: string, path: string, body: Record<string, unknown>) {
  try {
    return await call(path, { body: { auth_token: await shopToken(appShopId), ...body } });
  } catch (e) {
    if (!(e instanceof Food99Error) || !TOKEN_ERRORS.has(e.errno)) throw e;
    return call(path, { body: { auth_token: await shopToken(appShopId, true), ...body } });
  }
}

export const food99Api = {
  confirm: (shop: string, orderId: string) => shopCall(shop, '/v1/order/order/confirm', { order_id: bigId(orderId) }),
  ready: (shop: string, orderId: string) => shopCall(shop, '/v1/order/order/ready', { order_id: bigId(orderId) }),
  cancel: (shop: string, orderId: string, reasonId: number, reason: string) =>
    shopCall(shop, '/v1/order/order/cancel', { order_id: bigId(orderId), reason_id: reasonId, reason }),
  dispatch: (shop: string, orderId: string, courier: { name: string; phone: string }, deliveryEta: number) => {
    const [first, ...rest] = courier.name.trim().split(/\s+/);
    const now = Math.floor(Date.now() / 1000);
    return shopCall(shop, '/v1/order/selfdelivery/dispatch', {
      order_id: bigId(orderId),
      courier_info: {
        courier_name: courier.name, courier_first_name: first || courier.name, courier_last_name: rest.join(' ') || first || courier.name,
        courier_phone_code: '+55', courier_phone: courier.phone,
      },
      vehicle: { vehicle_type: 102 },
      limit_time: { pickup_time: now, delivery_time: Math.max(deliveryEta, now + 60) },
    });
  },
  delivered: (shop: string, orderId: string) => shopCall(shop, '/v1/order/selfdelivery/delivered', { order_id: bigId(orderId) }),
  bindUrl: async () => (await call('/v1/auth/authorizationpage/getUrl', { body: { app_id: bigId(config.FOOD99_APP_ID) } }))?.url as string,
};

// ---------------------------------------------------------------------------------------------
// Pedido do 99Food -> pedido do painel

const PAY_CHANNELS: Record<number, string> = {
  110: 'Cupom', 120: 'Carteira 99Food', 150: 'Cartão (no app)', 153: 'Dinheiro', 154: 'Maquininha na entrega', 190: '99Pay',
  212: 'Pix', 280: 'Pix', 229: 'NuPay', 234: 'Apple Pay', 235: 'Apple Pay', 257: 'VR Pluxee', 258: 'VR Ticket', 259: 'VR VR',
  260: 'VR Alelo', 262: 'Maquininha (crédito)', 263: 'Maquininha (débito)', 264: 'Maquininha (vale-refeição)', 272: 'Google Pay',
  273: 'Google Pay', 283: 'Compre agora, pague depois', 2008: 'Marketing', 901: 'Benefício', 167: 'Cartão (pré-autorização)',
};

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : Number(v) || 0);
const s = (v: unknown, max = 200) => cleanText(v == null ? '' : String(v), max);

function paymentOf(info: any) {
  const channel = n(info.pay_channel);
  const type = n(info.pay_type);
  const label = PAY_CHANNELS[channel] ?? (n(info.pay_method) === 1 ? 'Pago no app' : 'Pagar na entrega');
  if (n(info.pay_method) === 1 && type !== 2 && type !== 3) return { method: 'online' as const, label };
  if (type === 2 || channel === 153) return { method: 'cash' as const, label: 'Dinheiro' };
  return { method: 'card' as const, label };
}

interface ParsedItem {
  name: string; quantity: number; unit: number; addonsUnit: number; notes: string; productId: string | null;
  addons: { name: string; priceCents: number }[];
}

function flattenSubs(list: any[], depth = 0): { name: string; priceCents: number }[] {
  const out: { name: string; priceCents: number }[] = [];
  for (const sub of Array.isArray(list) ? list : []) {
    const qty = Math.max(1, n(sub.amount));
    out.push({ name: `${depth ? '  '.repeat(depth) : ''}${qty > 1 ? `${qty}x ` : ''}${s(sub.name, 80)}`, priceCents: n(sub.sku_price) * qty });
    out.push(...flattenSubs(sub.sub_item_list, depth + 1));
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseItems(list: any[]): ParsedItem[] {
  return (Array.isArray(list) ? list : []).map((it) => {
    const quantity = Math.min(99, Math.max(1, n(it.amount)));
    const unit = Math.max(0, n(it.sku_price));
    const addons = flattenSubs(it.sub_item_list);
    // total_price = (preço do item + adicionais) × quantidade. Quando não fecha, soma os adicionais.
    const total = n(it.total_price);
    const fromTotal = total > 0 && total % quantity === 0 ? total / quantity - unit : -1;
    const addonsUnit = fromTotal >= 0 ? fromTotal : addons.reduce((a, b) => a + b.priceCents, 0);
    const remark = Array.isArray(it.remark) ? it.remark.join('; ') : it.remark;
    const app = s(it.app_external_id || it.app_item_id, 80);
    return { name: s(it.name, 120) || 'Item', quantity, unit, addonsUnit, notes: s(remark, 140), productId: UUID.test(app) ? app : null, addons };
  });
}

// Valores do pedido. Entrega da loja (modelo de preço 2): o cliente paga real_pay_price; o que falta receber na
// porta é customer_need_paying_money. Entrega do 99 (modelo 1): a loja vê só os itens; a taxa fica com o 99.
export function totalsOf(info: any, items: ParsedItem[], storeDelivery: boolean) {
  const p = info.price ?? {};
  const subtotal = items.reduce((a, i) => a + (i.unit + i.addonsUnit) * i.quantity, 0);
  const fee = storeDelivery ? Math.max(0, n(p.delivery_price)) : 0;
  const fees = p.others_fees ?? {};
  let extras = Math.max(0, n(fees.small_order_price) + n(fees.service_price) + n(fees.total_tip_money) + n(fees.meal_top_up_price ?? p.meal_top_up_price));
  const total = storeDelivery && p.real_pay_price != null
    ? Math.max(0, n(p.real_pay_price))
    : Math.max(0, subtotal - Math.max(0, n(p.items_discount)) + extras);
  let discount = subtotal + fee + extras - total;
  if (discount < 0) {
    extras += -discount;
    discount = 0;
  }
  return { subtotal, fee, extras, discount, total };
}

async function nextNumber(db: Db, storeId: string) {
  const c = await db.query(
    `INSERT INTO store_counters (store_id, last_order_number) VALUES ($1, 1)
     ON CONFLICT (store_id) DO UPDATE SET last_order_number = store_counters.last_order_number + 1 RETURNING last_order_number`,
    [storeId],
  );
  return c.rows[0].last_order_number as number;
}

// Grava o pedido novo (ou devolve o já gravado, se o aviso vier repetido). Não fala com o 99Food.
export async function importOrder(storeId: string, appShopId: string, data: any) {
  const info = data?.order_info ?? data;
  const orderId = s(data?.order_id ?? info?.order_id, 40);
  if (!/^\d{1,25}$/.test(orderId)) throw new AppError(400, 'food99_invalid', 'Pedido do 99Food sem order_id.');
  return tx(async (db) => {
    const found = await db.query(`SELECT * FROM orders WHERE store_id = $1 AND channel = '99food' AND external_id = $2`, [storeId, orderId]);
    if (found.rows[0]) return { order: found.rows[0], created: false };

    const deliveryType = n(info.delivery_type);
    const pickup = n(info.fulfillment_mode) === 1 || deliveryType === 0;
    const external_delivery = pickup ? 'pickup' : deliveryType === 1 ? 'platform' : 'store';
    const storeDelivery = external_delivery === 'store';
    const items = parseItems(info.order_items);
    if (!items.length) throw new AppError(400, 'food99_invalid', 'Pedido do 99Food sem itens.');
    const t = totalsOf(info, items, storeDelivery);
    const pay = paymentOf(info);
    const p = info.price ?? {};
    const a = info.receive_address ?? {};
    const name = s(a.name, 80) || s([a.first_name, a.last_name].filter(Boolean).join(' '), 80) || 'Cliente 99Food';
    const virtualPhone = onlyDigits(s(a.virtual_phone_number, 30));
    const phone = virtualPhone || onlyDigits(s(a.phone, 30)) || '0';
    const cep = onlyDigits(s(a.postal_code ?? a.postalCode, 12));
    const street = pickup ? '' : s(a.street_name, 120) || s(a.poi_display_name, 120) || s(a.poi_address, 120);
    const number = pickup ? '' : s(a.street_number || a.house_number, 15);
    const collect = info.pay_method === 1 && pay.method === 'online' ? 0 : n(p.customer_need_paying_money);
    const changeFor = pay.method === 'cash' && n(info.change_for) > 0 ? n(info.change_for) : null;
    const notes = [s(info.remark, 250), info.need_cutlery ? 'Enviar talheres' : ''].filter(Boolean).join(' | ');
    const externalInfo = {
      orderIndex: info.order_index ?? null,
      payLabel: pay.label, payType: n(info.pay_type), payChannel: n(info.pay_channel),
      collectCents: storeDelivery || pickup ? collect : 0,
      shopPaidCents: n(p.shop_paid_money) || null,
      handoverCode: s(info.handover_code, 10) || null, takeawayCode: s(info.takeaway_code, 10) || null, pickupCode: s(info.pickup_code, 10) || null,
      virtualPhone: virtualPhone || null, locator: s(a.locator, 20) || null, handoverUrl: s(a.handover_page_url, 300) || null,
      lat: typeof a.poi_lat === 'number' ? a.poi_lat : null, lng: typeof a.poi_lng === 'number' ? a.poi_lng : null,
      expectedArrivedEta: n(info.expected_arrived_eta) || null,
      confirmed: false, ready: false, dispatched: false,
    };

    const number99 = await nextNumber(db, storeId);
    const o = await db.query(
      `INSERT INTO orders (store_id, number, public_token, idempotency_key, request_hash, customer_name, customer_phone, cep, street,
          street_number, complement, reference, neighborhood_name, city, notes, payment_method, change_for_cents,
          subtotal_cents, delivery_fee_cents, discount_cents, extra_fees_cents, total_cents, delivery_fee_source, fulfillment,
          channel, external_id, external_shop_id, external_short_code, external_delivery, external_info)
       VALUES ($1,$2,$3,$4,'99food',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'99food',$24,$25,$26,$27,$28)
       RETURNING *`,
      [
        storeId, number99, newToken(24), `99food-${orderId}`, name, phone, cep.length === 8 ? cep : '', street, number,
        pickup ? '' : s(a.complement, 80), pickup ? '' : s(a.reference, 120), pickup ? '' : s(a.district, 80), pickup ? '' : s(a.city, 80),
        notes, pay.method, changeFor, t.subtotal, t.fee, t.discount, t.extras, t.total, pickup ? 'pickup' : 'app', pickup ? 'pickup' : 'delivery',
        orderId, appShopId, info.order_index == null ? null : s(info.order_index, 10), external_delivery, JSON.stringify(externalInfo),
      ],
    );
    const order = o.rows[0];
    for (const [pos, i] of items.entries()) {
      let productId = i.productId;
      if (productId && !(await db.query('SELECT 1 FROM products WHERE id = $1 AND store_id = $2', [productId, storeId])).rowCount) productId = null;
      const it = await db.query(
        `INSERT INTO order_items (order_id, store_id, product_id, product_name, category_name, regular_price_cents, unit_price_cents,
            addons_unit_cents, quantity, line_total_cents, notes, position)
         VALUES ($1,$2,$3,$4,'99Food',$5,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [order.id, storeId, productId, i.name, i.unit, i.addonsUnit, i.quantity, (i.unit + i.addonsUnit) * i.quantity, i.notes, pos],
      );
      for (const ad of i.addons) {
        await db.query(`INSERT INTO order_item_addons (order_item_id, group_name, addon_name, price_cents) VALUES ($1,'',$2,$3)`, [it.rows[0].id, ad.name, ad.priceCents]);
      }
    }
    await db.query(
      `INSERT INTO order_status_history (order_id, store_id, from_status, to_status, note) VALUES ($1,$2,NULL,'received',$3)`,
      [order.id, storeId, `Pedido do 99Food${info.order_index != null ? ` nº ${info.order_index}` : ''}`],
    );
    const settings = await getSettings(db, storeId);
    if (settings.auto_print) await createPrintJob(db, storeId, { orderId: order.id, kind: 'original' });
    return { order, created: true };
  });
}

export async function setExternalFlags(db: Db, orderId: string, flags: Record<string, unknown>) {
  await db.query(`UPDATE orders SET external_info = coalesce(external_info, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [orderId, JSON.stringify(flags)]);
}

// Reflete no 99Food uma mudança de etapa feita no painel. Lança erro (e a mudança não é gravada) se o 99 recusar.
export async function pushStatusTo99(db: PoolClient, storeId: string, order: any, to: string, note: string, courier?: { name: string; phone: string } | null) {
  if (order.channel !== '99food' || !order.external_id || !order.external_shop_id) return;
  if (!food99Enabled()) throw new AppError(409, 'food99_disabled', 'A integração com o 99Food está desligada (faltam as credenciais no servidor).');
  const info = order.external_info ?? {};
  const shop = order.external_shop_id as string;
  const id = order.external_id as string;
  const flags: Record<string, unknown> = {};
  try {
    if (to === 'cancelled') {
      await food99Api.cancel(shop, id, 1080, note.trim().slice(0, 200) || 'Cancelado pela loja');
    } else {
      if (!info.confirmed) {
        await food99Api.confirm(shop, id);
        flags.confirmed = true;
      }
      if ((to === 'out_for_delivery' || to === 'completed') && !info.ready) {
        await food99Api.ready(shop, id);
        flags.ready = true;
      }
      if ((to === 'out_for_delivery' || to === 'completed') && order.external_delivery === 'store' && !info.dispatched) {
        // Motoboy da saída (aba Entregas) ou, sem ele, a própria loja com o telefone de Dados da loja.
        const st = await getSettings(db, storeId);
        const name = s(courier?.name, 60) || s(st.display_name, 60) || 'Entregador';
        const phone = onlyDigits(String(courier?.phone || st.phone || st.whatsapp || '')).replace(/^55(?=\d{10,11}$)/, '');
        await food99Api.dispatch(shop, id, { name, phone: phone || '0' }, n(info.expectedArrivedEta) || Math.floor(Date.now() / 1000) + 40 * 60);
        flags.dispatched = true;
      }
      if (to === 'completed' && order.external_delivery === 'store') await food99Api.delivered(shop, id);
    }
  } catch (e) {
    // A transação do painel vai ser desfeita: grava depois o que o 99 já aceitou (sem esperar, a linha está travada até lá).
    if (Object.keys(flags).length) {
      const f = JSON.stringify(flags);
      setImmediate(() => pool.query(`UPDATE orders SET external_info = coalesce(external_info, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [order.id, f]).catch(() => {}));
    }
    if (e instanceof Food99Error) throw new AppError(502, 'food99_refused', `O 99Food não aceitou a mudança: ${e.message}${e.errno > 0 ? ` (código ${e.errno})` : ''}`);
    throw e;
  }
  if (Object.keys(flags).length) await setExternalFlags(db, order.id, flags);
}

export async function logEvent(storeId: string | null, type: string, appShopId: string | null, orderId: string | null, result: string) {
  await pool.query(
    'INSERT INTO food99_events (store_id, type, app_shop_id, order_id, result) VALUES ($1,$2,$3,$4,$5)',
    [storeId, s(type, 40) || '?', appShopId ? s(appShopId, 80) : null, orderId, s(result, 300)],
  ).catch(() => {});
}
