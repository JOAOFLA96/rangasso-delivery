import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setFood99Fetch, parseJsonBig, stringifyBig, bigId, totalsOf, parseItems } from '../src/services/food99.js';
import { resetDb, seed, makeApp, loginAs, pool, type Fixture } from './helpers.js';

const SECRET = 'segredo-de-teste-99food';
const APP_ID = '5764607584567296012';
const ORDER_ID = '1152921547153933576'; // maior que Number.MAX_SAFE_INTEGER
const SHOP = 'rangasso-01';

let app: Awaited<ReturnType<typeof makeApp>>;
let f: Fixture;
let calls: { path: string; query: Record<string, string>; body: string | null }[];
let replies: Record<string, (body: string | null) => object>;

function fake99() {
  calls = [];
  replies = {
    '/v1/auth/authtoken/get': () => ({ errno: 0, errmsg: 'ok', data: { app_id: 1, app_shop_id: SHOP, auth_token: 'TOKEN-1', token_expiration_time: Math.floor(Date.now() / 1000) + 3600 } }),
    '/v1/auth/authtoken/refresh': () => ({ errno: 0, errmsg: 'ok', data: true }),
  };
  setFood99Fetch((async (input: any, init?: any) => {
    const url = new URL(String(input));
    const body = init?.body ? String(init.body) : null;
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    const r = replies[url.pathname]?.(body) ?? { errno: 0, errmsg: 'ok', data: true };
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any);
}

beforeEach(async () => {
  await resetDb();
  f = await seed();
  app ??= await makeApp();
  fake99();
});
afterEach(() => setFood99Fetch(null));
afterAll(async () => {
  await app.close();
});

const sign = (raw: string) => createHash('md5').update(raw + SECRET).digest('hex');
const hook = (raw: string, signature = sign(raw)) =>
  app.inject({ method: 'POST', url: '/api/integrations/99food/webhook', headers: { 'content-type': 'application/json', 'didi-header-sign': signature }, payload: raw });

// Pedido no formato do 99Food (inteiros de 64 bits escritos como número no JSON, como o 99 envia).
function orderNewRaw(over: { delivery_type?: number; pay_method?: number; pay_type?: number; pay_channel?: number; fulfillment_mode?: number } = {}) {
  const info = {
    order_id: '__OID__', status: 100, order_index: 7, remark: 'Sem cebola', country: 'BR', timezone: 'America/Sao_Paulo',
    pay_type: over.pay_type ?? 1, pay_method: over.pay_method ?? 1, pay_channel: over.pay_channel ?? 212, change_for: 0,
    delivery_type: over.delivery_type ?? 2, fulfillment_mode: over.fulfillment_mode ?? 0, need_cutlery: true, handover_code: '5000',
    expected_arrived_eta: 1900000000,
    price: {
      order_price: 8600, real_price: 9100, real_pay_price: 8600, delivery_price: 500, items_discount: 500, delivery_discount: 0,
      others_fees: { small_order_price: 0, total_tip_money: 0, service_price: 0, coupon_discount: 0 }, customer_need_paying_money: 0,
    },
    shop: { shop_id: '__SID__', app_shop_id: SHOP, shop_name: 'Rangasso' },
    receive_address: {
      name: 'Maria Souza', calling_code: '+55', phone: '000****1406', virtual_phone_number: '11999990000', locator: '5624',
      street_name: 'Rua das Flores', street_number: '120', district: 'Cidade Nova I', city: 'Indaiatuba', postal_code: '13334-050',
      complement: 'Casa 2', reference: 'Portão azul', poi_lat: -23.09, poi_lng: -47.21, handover_page_url: 'https://food-b-h5.99app.com/x',
    },
    order_items: [
      {
        app_item_id: 'x1', name: 'X-Rangasso', sku_price: 3000, total_price: 7000, amount: 2, remark: 'bem passado',
        sub_item_list: [{ app_item_id: 's1', name: 'Bacon', sku_price: 500, amount: 1, sub_item_list: [] }],
      },
      { app_item_id: 'x2', name: 'Refrigerante', sku_price: 1600, total_price: 1600, amount: 1, sub_item_list: [] },
    ],
  };
  return JSON.stringify({ app_id: '__APP__', app_shop_id: SHOP, timestamp: 1615432308, type: 'orderNew', data: { order_id: '__OID__', order_info: info } })
    .replaceAll('"__OID__"', ORDER_ID).replaceAll('"__SID__"', '5764607688097661019').replaceAll('"__APP__"', APP_ID);
}

const order99 = async () => (await pool.query(`SELECT * FROM orders WHERE channel = '99food'`)).rows[0];
async function until(fn: () => Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('tempo esgotado');
}

describe('JSON do 99Food', () => {
  it('lê e escreve IDs de 64 bits sem perder dígitos', () => {
    const v = parseJsonBig(`{"order_id":${ORDER_ID},"n":5,"x":1.5}`);
    expect(v).toEqual({ order_id: ORDER_ID, n: 5, x: 1.5 });
    expect(stringifyBig({ order_id: bigId(ORDER_ID), auth_token: 'a' })).toBe(`{"order_id":${ORDER_ID},"auth_token":"a"}`);
  });
  it('valores: entrega da loja usa o que o cliente pagou e separa o desconto', () => {
    const items = parseItems([{ name: 'A', sku_price: 3000, total_price: 7000, amount: 2, sub_item_list: [{ name: 'B', sku_price: 500, amount: 1 }] }]);
    expect(items[0]).toMatchObject({ quantity: 2, unit: 3000, addonsUnit: 500 });
    expect(totalsOf({ price: { delivery_price: 500, real_pay_price: 7000, items_discount: 500 } }, items, true)).toEqual({ subtotal: 7000, fee: 500, extras: 0, discount: 500, total: 7000 });
    // Taxa de serviço do app aparece como taxa extra.
    expect(totalsOf({ price: { delivery_price: 0, real_pay_price: 7300, others_fees: { service_price: 300 } } }, items, true)).toMatchObject({ extras: 300, discount: 0, total: 7300 });
  });
});

describe('webhook do 99Food', () => {
  it('recusa aviso com assinatura errada', async () => {
    const res = await hook(orderNewRaw(), 'a'.repeat(32));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ errno: 1 });
    expect(await order99()).toBeUndefined();
  });

  it('pedido novo entra no painel, vai para a impressão e é aceito sozinho no 99', async () => {
    const res = await hook(orderNewRaw());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ errno: 0, errmsg: 'ok' });
    const o = await order99();
    expect(o).toMatchObject({
      external_id: ORDER_ID, external_shop_id: SHOP, external_short_code: '7', external_delivery: 'store', fulfillment: 'delivery',
      customer_name: 'Maria Souza', customer_phone: '11999990000', street: 'Rua das Flores', street_number: '120', neighborhood_name: 'Cidade Nova I',
      cep: '13334050', payment_method: 'online', subtotal_cents: 8600, delivery_fee_cents: 500, discount_cents: 500, total_cents: 8600,
      notes: 'Sem cebola | Enviar talheres',
    });
    expect(o.external_info).toMatchObject({ payLabel: 'Pix', locator: '5624', collectCents: 0 });
    const items = (await pool.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY position', [o.id])).rows;
    expect(items.map((i) => [i.product_name, i.quantity, i.unit_price_cents, i.addons_unit_cents, i.notes])).toEqual([
      ['X-Rangasso', 2, 3000, 500, 'bem passado'], ['Refrigerante', 1, 1600, 0, ''],
    ]);
    const job = (await pool.query('SELECT payload FROM print_jobs WHERE order_id = $1', [o.id])).rows[0];
    expect(job.payload.order).toMatchObject({ channel: '99food', externalCode: '7', paymentLabel: 'Pix', customerPhone: '11999990000 ramal 5624' });

    await until(async () => (await order99()).status === 'confirmed');
    const confirm = calls.find((c) => c.path === '/v1/order/order/confirm')!;
    expect(confirm.body).toBe(`{"auth_token":"TOKEN-1","order_id":${ORDER_ID}}`);
    expect(calls[0]).toMatchObject({ path: '/v1/auth/authtoken/get', query: { app_id: APP_ID, app_secret: SECRET, app_shop_id: SHOP } });
    expect((await order99()).external_info.confirmed).toBe(true);
  });

  it('aviso repetido não duplica o pedido', async () => {
    await hook(orderNewRaw());
    const again = await hook(orderNewRaw());
    expect(again.json()).toMatchObject({ errno: 0 });
    expect((await pool.query(`SELECT count(*)::int AS n FROM orders WHERE channel = '99food'`)).rows[0].n).toBe(1);
  });

  it('aceite que falha deixa o pedido em Recebido com aviso no histórico', async () => {
    replies['/v1/order/order/confirm'] = () => ({ errno: 10001, errmsg: 'System error' });
    await hook(orderNewRaw());
    const o = await order99();
    await until(async () => (await pool.query(`SELECT 1 FROM order_status_history WHERE order_id = $1 AND note LIKE 'Aceite automático%'`, [o.id])).rowCount === 1);
    expect((await order99()).status).toBe('received');
  });

  it('cancelamento e conclusão feitos no 99 chegam ao painel', async () => {
    await hook(orderNewRaw());
    await until(async () => (await order99()).status === 'confirmed');
    const raw = JSON.stringify({ app_id: 1, app_shop_id: SHOP, type: 'orderCancel', timestamp: 1, data: { order_id: '__OID__' } }).replace('"__OID__"', ORDER_ID).replace('"app_id":1', `"app_id":${APP_ID}`);
    expect((await hook(raw)).json()).toMatchObject({ errno: 0 });
    const o = await order99();
    expect(o.status).toBe('cancelled');
    expect(o.cancel_reason).toContain('99Food');
    expect(calls.some((c) => c.path === '/v1/order/order/cancel')).toBe(false); // não devolve ao 99
  });

  it('loja ligada ao app pelo link de autorização é registrada', async () => {
    const raw = JSON.stringify({ app_id: 1, type: 'shopBindStatus', timestamp: 1, data: { appShopIDList: ['b2a0e81c-3af9'], bindStatus: 'bind' } }).replace('"app_id":1', `"app_id":${APP_ID}`);
    expect((await hook(raw)).json()).toMatchObject({ errno: 0 });
    await until(async () => (await pool.query(`SELECT auth_token FROM food99_shops WHERE app_shop_id = 'b2a0e81c-3af9'`)).rows[0]?.auth_token === 'TOKEN-1');
  });

  it('recusa aviso de outro app', async () => {
    const raw = orderNewRaw().replace(`"app_id":${APP_ID}`, '"app_id":123');
    expect((await hook(raw)).statusCode).toBe(403);
  });
});

describe('painel -> 99Food', () => {
  async function setup() {
    await hook(orderNewRaw());
    await until(async () => (await order99()).status === 'confirmed');
    calls.length = 0;
    return { o: await order99(), h: await loginAs(app, 'gerente@t.local') };
  }
  const setStatus = (id: string, h: any, status: string, note = '') => app.inject({ method: 'POST', url: `/api/admin/orders/${id}/status`, headers: h, payload: { status, note } });

  it('saiu para entrega avisa pronto + despacho; concluir avisa entregue', async () => {
    const { o, h } = await setup();
    await pool.query(`UPDATE store_settings SET phone = '(19) 99876-5432' WHERE store_id = $1`, [f.storeId]);
    expect((await setStatus(o.id, h, 'out_for_delivery')).statusCode).toBe(200);
    expect(calls.map((c) => c.path)).toEqual(['/v1/order/order/ready', '/v1/order/selfdelivery/dispatch']);
    const d = JSON.parse(calls[1].body!);
    expect(d.courier_info).toMatchObject({ courier_phone_code: '+55', courier_phone: '19998765432' });
    expect(calls[1].body).toContain(`"order_id":${ORDER_ID}`);
    calls.length = 0;
    expect((await setStatus(o.id, h, 'completed')).statusCode).toBe(200);
    expect(calls.map((c) => c.path)).toEqual(['/v1/order/selfdelivery/delivered']);
  });

  it('se o 99 recusar o cancelamento, o pedido não muda no painel', async () => {
    const { o, h } = await setup();
    replies['/v1/order/order/cancel'] = () => ({ errno: 30001, errmsg: 'order status not allowed' });
    const res = await setStatus(o.id, h, 'cancelled', 'Acabou o pão');
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toContain('order status not allowed');
    expect((await order99()).status).toBe('confirmed');
    expect(JSON.parse(calls.find((c) => c.path === '/v1/order/order/cancel')!.body!)).toMatchObject({ reason_id: 1080, reason: 'Acabou o pão' });
  });

  it('token vencido: renova e repete a chamada', async () => {
    const { o, h } = await setup();
    let first = true;
    replies['/v1/order/order/ready'] = () => (first ? ((first = false), { errno: 10102, errmsg: 'auth_token has expired' }) : { errno: 0, data: true });
    expect((await setStatus(o.id, h, 'out_for_delivery')).statusCode).toBe(200);
    expect(calls.map((c) => c.path)).toEqual([
      '/v1/order/order/ready', '/v1/auth/authtoken/get', '/v1/auth/authtoken/refresh', '/v1/auth/authtoken/get', '/v1/order/order/ready', '/v1/order/selfdelivery/dispatch',
    ]);
  });

  it('saída da aba Entregas envia ao 99 o motoboy escolhido', async () => {
    const { o } = await setup();
    const owner = await loginAs(app, 'dono@t.local');
    const c = (await app.inject({ method: 'POST', url: '/api/admin/couriers', headers: owner, payload: { name: 'Carlos Lima', phone: '(19) 99876-5432' } })).json().id;
    const run = await app.inject({ method: 'POST', url: '/api/admin/delivery-runs', headers: owner, payload: { courierId: c, orderIds: [o.id] } });
    expect(run.statusCode).toBe(201);
    calls.length = 0;
    const dep = await app.inject({ method: 'POST', url: `/api/admin/delivery-runs/${run.json().id ?? run.json().run?.id}/depart`, headers: owner });
    expect(dep.statusCode).toBe(200);
    const d = JSON.parse(calls.find((x) => x.path === '/v1/order/selfdelivery/dispatch')!.body!);
    expect(d.courier_info).toMatchObject({ courier_name: 'Carlos Lima', courier_first_name: 'Carlos', courier_last_name: 'Lima', courier_phone: '19998765432' });
    expect((await order99()).status).toBe('out_for_delivery');
  });

  it('tela de configuração mostra a integração e o endereço do webhook', async () => {
    const { h } = await setup();
    const r = (await app.inject({ method: 'GET', url: '/api/admin/integrations/99food', headers: h })).json();
    expect(r).toMatchObject({ configured: true, autoConfirm: true, orders: { total: 1 } });
    expect(r.webhookUrl).toMatch(/\/api\/integrations\/99food\/webhook$/);
    expect(r.shops[0]).toMatchObject({ appShopId: SHOP, bound: true, tokenOk: true });
    const list = (await app.inject({ method: 'GET', url: '/api/admin/orders?channel=99food', headers: h })).json();
    expect(list.orders[0]).toMatchObject({ channel: '99food', external_short_code: '7' });
  });
});
