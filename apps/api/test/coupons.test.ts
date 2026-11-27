import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seed, makeApp, orderBody, loginAs, pool, type Fixture } from './helpers.js';
import { buildReceiptPayload } from '../src/services/print.js';
import { discountFor, normalizeCouponCode } from '../src/services/coupons.js';

let app: Awaited<ReturnType<typeof makeApp>>;
let f: Fixture;
let owner: Record<string, string>;

beforeEach(async () => {
  await resetDb();
  f = await seed();
  app ??= await makeApp();
  owner = await loginAs(app, 'dono@t.local');
});
afterAll(async () => {
  await app.close();
});

// Pedido padrão: 2x Burger com bacon = R$ 70,00 + taxa Centro R$ 6,00 = R$ 76,00.
const create = (body: Record<string, any>, headers = owner) => app.inject({ method: 'POST', url: '/api/admin/coupons', headers, payload: body });
const post = (payload: any) => app.inject({ method: 'POST', url: '/api/public/orders', payload });
const quote = (extra: Record<string, any> = {}) =>
  app.inject({ method: 'POST', url: '/api/public/quote', payload: { items: orderBody(f).items, neighborhoodId: f.hoodAId, ...extra } });
const orderRow = async (token: string) => (await pool.query('SELECT * FROM orders WHERE public_token = $1', [token])).rows[0];

describe('cupons de desconto', () => {
  it('regras de cálculo', () => {
    expect(normalizeCouponCode(' bem vindo10 ')).toBe('BEMVINDO10');
    expect(discountFor({ kind: 'percent', percent: 10, amount_cents: null, max_discount_cents: null }, 7000, 600)).toBe(700);
    expect(discountFor({ kind: 'percent', percent: 50, amount_cents: null, max_discount_cents: 1500 }, 7000, 600)).toBe(1500);
    expect(discountFor({ kind: 'fixed', percent: null, amount_cents: 9000, max_discount_cents: null }, 7000, 600)).toBe(7000);
    expect(discountFor({ kind: 'free_delivery', percent: null, amount_cents: null, max_discount_cents: null }, 7000, 600)).toBe(600);
  });

  it('porcentagem: prévia, pedido, painel, acompanhamento e impressão', async () => {
    expect((await create({ code: 'bemvindo10', kind: 'percent', percent: 10, description: 'Boas-vindas' })).statusCode).toBe(200);
    const q = (await quote({ couponCode: 'BemVindo10' })).json();
    expect(q).toMatchObject({ subtotalCents: 7000, deliveryFeeCents: 600, discountCents: 700, totalCents: 6900, couponError: null, coupon: { code: 'BEMVINDO10' } });

    const res = await post(orderBody(f, { couponCode: 'bemvindo10' }));
    expect(res.statusCode).toBe(201);
    expect(res.json().totalCents).toBe(6900);
    const o = await orderRow(res.json().token);
    expect(o).toMatchObject({ discount_cents: 700, total_cents: 6900, coupon_code: 'BEMVINDO10' });

    const pub = (await app.inject({ method: 'GET', url: `/api/public/orders/${res.json().token}` })).json();
    expect(pub).toMatchObject({ discountCents: 700, couponCode: 'BEMVINDO10' });
    const payload: any = await buildReceiptPayload(pool, f.storeId, o.id);
    expect(payload.order).toMatchObject({ discountCents: 700, couponCode: 'BEMVINDO10', totalCents: 6900 });

    const list = (await app.inject({ method: 'GET', url: '/api/admin/orders?coupon=bemvindo10', headers: owner })).json();
    expect(list.total).toBe(1);
    expect(list.orders[0].coupon_code).toBe('BEMVINDO10');

    const rep = (await app.inject({ method: 'GET', url: '/api/admin/coupons', headers: owner })).json().coupons[0];
    expect(rep.report).toMatchObject({ uses: 1, discountTotalCents: 700, revenueCents: 6900, averageTicketCents: 6900, customers: 1 });
  });

  it('valor fixo, teto da porcentagem e entrega grátis', async () => {
    await create({ code: 'MENOS15', kind: 'fixed', amountCents: 1500 });
    await create({ code: 'METADE', kind: 'percent', percent: 50, maxDiscountCents: 2000 });
    await create({ code: 'FRETEZERO', kind: 'free_delivery' });
    expect((await quote({ couponCode: 'MENOS15' })).json()).toMatchObject({ discountCents: 1500, totalCents: 6100 });
    expect((await quote({ couponCode: 'METADE' })).json()).toMatchObject({ discountCents: 2000, totalCents: 5600 });
    expect((await quote({ couponCode: 'FRETEZERO' })).json()).toMatchObject({ discountCents: 600, totalCents: 7000 });
    const res = await post(orderBody(f, { couponCode: 'FRETEZERO' }));
    expect(res.statusCode).toBe(201);
    expect(await orderRow(res.json().token)).toMatchObject({ delivery_fee_cents: 600, discount_cents: 600, total_cents: 7000 });
  });

  it('entrega grátis não vale na retirada', async () => {
    await pool.query('UPDATE store_settings SET accepts_pickup = true WHERE store_id = $1', [f.storeId]);
    await create({ code: 'FRETEZERO', kind: 'free_delivery' });
    const res = await post(orderBody(f, { fulfillment: 'pickup', address: undefined, couponCode: 'FRETEZERO' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'coupon_invalid', details: { field: 'couponCode' } });
  });

  it('cupom inválido: a prévia avisa sem derrubar; o pedido é recusado', async () => {
    const q = (await quote({ couponCode: 'NAOEXISTE' })).json();
    expect(q).toMatchObject({ discountCents: 0, totalCents: 7600, coupon: null });
    expect(q.couponError).toMatch(/inválido/);
    const res = await post(orderBody(f, { couponCode: 'NAOEXISTE' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('coupon_invalid');
    expect((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n).toBe(0);
  });

  it('pedido mínimo, validade e desativado', async () => {
    await create({ code: 'MIN100', kind: 'fixed', amountCents: 1000, minOrderCents: 10000 });
    await create({ code: 'VENCIDO', kind: 'fixed', amountCents: 1000, endsAt: new Date(Date.now() - 60_000).toISOString() });
    await create({ code: 'FUTURO', kind: 'fixed', amountCents: 1000, startsAt: new Date(Date.now() + 3600_000).toISOString() });
    await create({ code: 'DESLIGADO', kind: 'fixed', amountCents: 1000, active: false });
    expect((await quote({ couponCode: 'MIN100' })).json().couponError).toMatch(/a partir de R\$ 100,00/);
    expect((await quote({ couponCode: 'VENCIDO' })).json().couponError).toMatch(/expirou/);
    expect((await quote({ couponCode: 'FUTURO' })).json().couponError).toMatch(/ainda não/);
    expect((await quote({ couponCode: 'DESLIGADO' })).json().couponError).toMatch(/desativado/);
  });

  it('limite total e por cliente; cancelado devolve o uso', async () => {
    await create({ code: 'UMAVEZ', kind: 'fixed', amountCents: 500, maxUsesPerPhone: 1 });
    await create({ code: 'DOIS', kind: 'fixed', amountCents: 500, maxUses: 2 });
    const first = await post(orderBody(f, { couponCode: 'UMAVEZ' }));
    expect(first.statusCode).toBe(201);
    const again = await post(orderBody(f, { couponCode: 'UMAVEZ' }));
    expect(again.json().error.message).toMatch(/já usou/);
    // Na prévia, com o telefone, o cliente já fica sabendo.
    expect((await quote({ couponCode: 'UMAVEZ', phone: '(11) 98765-4321' })).json().couponError).toMatch(/já usou/);
    // Outro cliente pode usar.
    const other = await post(orderBody(f, { couponCode: 'UMAVEZ', customer: { name: 'Outra', phone: '(11) 91234-5678' } }));
    expect(other.statusCode).toBe(201);

    // Pedido cancelado não conta.
    const o = await orderRow(first.json().token);
    const cancel = await app.inject({ method: 'POST', url: `/api/admin/orders/${o.id}/status`, headers: owner, payload: { status: 'cancelled', note: 'teste' } });
    expect(cancel.statusCode).toBe(200);
    expect((await post(orderBody(f, { couponCode: 'UMAVEZ' }))).statusCode).toBe(201);

    // Limite total: dois pedidos ao mesmo tempo para a última vaga, só um passa.
    expect((await post(orderBody(f, { couponCode: 'DOIS' }))).statusCode).toBe(201);
    const [a, b] = await Promise.all([
      post(orderBody(f, { couponCode: 'DOIS', customer: { name: 'Ana', phone: '(11) 90000-0001' } })),
      post(orderBody(f, { couponCode: 'DOIS', customer: { name: 'Bia', phone: '(11) 90000-0002' } })),
    ]);
    expect([a.statusCode, b.statusCode].sort(), a.body + b.body).toEqual([201, 400]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM orders WHERE coupon_code = 'DOIS'`)).rows[0].n).toBe(2);
  });

  it('só no primeiro pedido', async () => {
    await create({ code: 'PRIMEIRA', kind: 'percent', percent: 20, firstOrderOnly: true });
    expect((await post(orderBody(f))).statusCode).toBe(201);
    const res = await post(orderBody(f, { couponCode: 'PRIMEIRA' }));
    expect(res.json().error.message).toMatch(/primeiro pedido/);
    expect((await post(orderBody(f, { couponCode: 'PRIMEIRA', customer: { name: 'Nova', phone: '(11) 95555-4444' } }))).statusCode).toBe(201);
  });

  it('troco é conferido com o total já com desconto', async () => {
    await create({ code: 'MENOS20', kind: 'fixed', amountCents: 2000 });
    const res = await post(orderBody(f, { couponCode: 'MENOS20', payment: { method: 'cash', changeForCents: 5600 } }));
    expect(res.statusCode).toBe(201);
    expect(res.json().totalCents).toBe(5600);
  });

  it('painel: permissões, código duplicado, código travado após uso e exclusão', async () => {
    const staff = await loginAs(app, 'atendente@t.local');
    expect((await create({ code: 'X10', kind: 'fixed', amountCents: 100 }, staff)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/coupons', headers: staff })).statusCode).toBe(200);
    expect((await create({ code: 'a b', kind: 'fixed', amountCents: 100 })).json().error.code).toBe('invalid_code');
    expect((await create({ code: 'PCT', kind: 'percent' })).json().error.code).toBe('invalid_percent');
    const id = (await create({ code: 'promo-5', kind: 'fixed', amountCents: 500 })).json().id;
    expect((await create({ code: 'PROMO-5', kind: 'fixed', amountCents: 100 })).json().error.code).toBe('duplicate_code');

    const put = (body: any) => app.inject({ method: 'PUT', url: `/api/admin/coupons/${id}`, headers: owner, payload: body });
    expect((await put({ code: 'PROMO-6', kind: 'fixed', amountCents: 600 })).statusCode).toBe(200);
    expect((await post(orderBody(f, { couponCode: 'promo-6' }))).json().totalCents).toBe(7000);
    expect((await put({ code: 'PROMO-7', kind: 'fixed', amountCents: 600 })).json().error.code).toBe('code_locked');
    expect((await put({ code: 'PROMO-6', kind: 'fixed', amountCents: 600, active: false })).statusCode).toBe(200);
    expect((await quote({ couponCode: 'PROMO-6' })).json().couponError).toMatch(/desativado/);

    // Usado: some da lista, mas o pedido continua com o código; o código pode ser criado de novo.
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/coupons/${id}`, headers: owner })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/admin/coupons', headers: owner })).json().coupons).toHaveLength(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM orders WHERE coupon_code = 'PROMO-6'`)).rows[0].n).toBe(1);
    expect((await create({ code: 'PROMO-6', kind: 'fixed', amountCents: 100 })).statusCode).toBe(200);
  });
});
