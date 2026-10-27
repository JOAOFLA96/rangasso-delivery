import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seed, makeApp, orderBody, loginAs, pool, type Fixture } from './helpers.js';
import { buildReceiptPayload } from '../src/services/print.js';
import { pushForStatus } from '../src/services/push.js';

let app: Awaited<ReturnType<typeof makeApp>>;
let f: Fixture;

beforeEach(async () => {
  await resetDb();
  f = await seed();
  app ??= await makeApp();
});
afterAll(async () => {
  await app.close();
});

const pickupBody = () => orderBody(f, { fulfillment: 'pickup', address: undefined });
const post = (payload: any) => app.inject({ method: 'POST', url: '/api/public/orders', payload });

describe('retirada na loja', () => {
  it('pedido sem endereço e sem taxa', async () => {
    const res = await post(pickupBody());
    expect(res.statusCode).toBe(201);
    const o = (await pool.query('SELECT * FROM orders WHERE public_token = $1', [res.json().token])).rows[0];
    expect(o).toMatchObject({ fulfillment: 'pickup', delivery_fee_cents: 0, delivery_fee_source: 'pickup', street: '', neighborhood_id: null });
    expect(o.total_cents).toBe(o.subtotal_cents);
    const pub = (await app.inject({ method: 'GET', url: `/api/public/orders/${res.json().token}` })).json();
    expect(pub).toMatchObject({ fulfillment: 'pickup', address: null });
    const payload = await buildReceiptPayload(pool, f.storeId, o.id);
    expect(payload.order).toMatchObject({ fulfillment: 'pickup', address: { street: '*** RETIRADA NA LOJA ***' } });
  });

  it('cotação sem taxa; entrega continua exigindo endereço', async () => {
    const q = (await app.inject({ method: 'POST', url: '/api/public/quote', payload: { items: pickupBody().items, fulfillment: 'pickup' } })).json();
    expect(q).toMatchObject({ deliveryFeeCents: 0, deliveryFeePending: false });
    expect(q.totalCents).toBe(q.subtotalCents);
    const bad = await post(orderBody(f, { address: undefined }));
    expect(bad.statusCode).toBe(400);
  });

  it('loja pode desligar a retirada', async () => {
    const h = await loginAs(app, 'gerente@t.local');
    const s = (await app.inject({ method: 'GET', url: '/api/admin/settings', headers: h })).json().settings;
    expect(s.acceptsPickup).toBe(true);
    const put = await app.inject({
      method: 'PUT', url: '/api/admin/settings/delivery', headers: h,
      payload: { minOrderCents: s.minOrderCents, etaMinMinutes: s.etaMinMinutes, etaMaxMinutes: s.etaMaxMinutes, openMode: s.openMode, acceptsPickup: false },
    });
    expect(put.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/public/store' })).json().acceptsPickup).toBe(false);
    expect((await post(pickupBody())).json().error.code).toBe('pickup_not_accepted');
  });

  it('status e avisos falam em retirar', async () => {
    const res = await post(pickupBody());
    const id = (await pool.query('SELECT id FROM orders WHERE public_token = $1', [res.json().token])).rows[0].id;
    const h = await loginAs(app, 'gerente@t.local');
    for (const status of ['confirmed', 'out_for_delivery']) {
      expect((await app.inject({ method: 'POST', url: `/api/admin/orders/${id}/status`, headers: h, payload: { status, note: '' } })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'GET', url: `/api/public/orders/${res.json().token}` })).json().statusLabel).toBe('Pronto para retirar');
    expect(pushForStatus(5, 'preparing', 'out_for_delivery', 't', 'pickup')?.title).toBe('Pedido #5 pronto para retirar 🛍️');
    expect(pushForStatus(5, 'preparing', 'out_for_delivery', 't')?.title).toContain('saiu para entrega');
  });
});
