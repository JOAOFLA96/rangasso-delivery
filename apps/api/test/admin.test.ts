import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seed, makeApp, orderBody, loginAs, pool, PASSWORD, type Fixture } from './helpers.js';

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

describe('autenticação e permissões', () => {
  it('rotas administrativas exigem login', async () => {
    for (const url of ['/api/admin/orders', '/api/admin/menu', '/api/admin/settings', '/api/admin/printer/status', '/api/admin/events']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
  });

  it('login, sessão e logout', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'rangasso' }, payload: { email: 'dono@t.local', password: 'errada' } });
    expect(bad.statusCode).toBe(401);
    const h = await loginAs(app, 'dono@t.local');
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: h })).json().user.role).toBe('owner');
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: h });
    expect((await app.inject({ method: 'GET', url: '/api/admin/orders', headers: h })).statusCode).toBe(401);
  });

  it('bloqueia a conta após 5 senhas erradas', async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'rangasso' }, payload: { email: 'dono@t.local', password: 'errada' } });
    }
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'rangasso' }, payload: { email: 'dono@t.local', password: PASSWORD } });
    expect(res.statusCode).toBe(429);
  });

  it('alteração sem cabeçalho anti-CSRF é recusada', async () => {
    const h = await loginAs(app, 'dono@t.local');
    const res = await app.inject({ method: 'POST', url: '/api/admin/categories', headers: { cookie: h.cookie }, payload: { name: 'X' } });
    expect(res.statusCode).toBe(403);
  });

  it('atendente não edita cardápio nem usuários, mas marca produto como esgotado', async () => {
    const h = await loginAs(app, 'atendente@t.local');
    expect((await app.inject({ method: 'POST', url: '/api/admin/categories', headers: h, payload: { name: 'X' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/users', headers: h })).statusCode).toBe(403);
    const r = await app.inject({ method: 'PATCH', url: `/api/admin/products/${f.burgerId}/availability`, headers: h, payload: { available: false } });
    expect(r.statusCode).toBe(200);
    const menu = (await app.inject({ method: 'GET', url: '/api/public/menu' })).json();
    expect(menu.categories[0].products.find((p: any) => p.id === f.burgerId).available).toBe(false);
  });
});

describe('cardápio pelo painel', () => {
  it('criar, editar, promover, arquivar e refletir no cardápio público', async () => {
    const h = await loginAs(app, 'gerente@t.local');
    const cat = (await app.inject({ method: 'POST', url: '/api/admin/categories', headers: h, payload: { name: 'Porções' } })).json();
    const created = await app.inject({
      method: 'POST', url: '/api/admin/products', headers: h,
      payload: { categoryId: cat.id, name: 'Batata', description: '400 g', priceCents: 2900 },
    });
    expect(created.statusCode).toBe(200);
    const pid = created.json().id;
    let menu = (await app.inject({ method: 'GET', url: '/api/public/menu' })).json();
    expect(menu.categories.find((c: any) => c.name === 'Porções').products[0].effectivePriceCents).toBe(2900);

    const invalidPromo = await app.inject({
      method: 'PUT', url: `/api/admin/products/${pid}`, headers: h,
      payload: { categoryId: cat.id, name: 'Batata', priceCents: 2900, promoPriceCents: 3000, promoActive: true },
    });
    expect(invalidPromo.statusCode).toBe(400);

    await app.inject({
      method: 'PUT', url: `/api/admin/products/${pid}`, headers: h,
      payload: { categoryId: cat.id, name: 'Batata G', priceCents: 3100, promoPriceCents: 2500, promoActive: true, promoEndsAt: new Date(Date.now() + 3600e3).toISOString() },
    });
    menu = (await app.inject({ method: 'GET', url: '/api/public/menu' })).json();
    const p = menu.categories.find((c: any) => c.name === 'Porções').products[0];
    expect([p.name, p.effectivePriceCents, p.priceCents]).toEqual(['Batata G', 2500, 3100]);

    expect((await app.inject({ method: 'DELETE', url: `/api/admin/products/${pid}`, headers: h })).statusCode).toBe(200);
    menu = (await app.inject({ method: 'GET', url: '/api/public/menu' })).json();
    expect(menu.categories.find((c: any) => c.name === 'Porções')).toBeUndefined();
    const audit = (await pool.query(`SELECT action FROM audit_log WHERE entity = 'product' ORDER BY id`)).rows.map((r) => r.action);
    expect(audit).toEqual(['product.create', 'product.update', 'product.archive']);
  });

  it('arquivar produto vendido não quebra o pedido antigo', async () => {
    const { token } = (await app.inject({ method: 'POST', url: '/api/public/orders', payload: orderBody(f) })).json();
    const h = await loginAs(app, 'dono@t.local');
    await app.inject({ method: 'DELETE', url: `/api/admin/products/${f.burgerId}`, headers: h });
    const o = await app.inject({ method: 'GET', url: `/api/public/orders/${token}` });
    expect(o.json().items[0].name).toBe('Burger');
  });

  it('bairros e taxas atualizam o checkout', async () => {
    const h = await loginAs(app, 'gerente@t.local');
    await app.inject({ method: 'PUT', url: `/api/admin/neighborhoods/${f.hoodAId}`, headers: h, payload: { name: 'Centro', feeCents: 900, active: true } });
    const res = await app.inject({ method: 'POST', url: '/api/public/orders', payload: orderBody(f) });
    expect(res.json().totalCents).toBe(7000 + 900);
    const dup = await app.inject({ method: 'POST', url: '/api/admin/neighborhoods', headers: h, payload: { name: 'centro', feeCents: 100 } });
    expect(dup.json().error.code).toBe('duplicate_neighborhood');
  });

  it('horários e exceções', async () => {
    const h = await loginAs(app, 'gerente@t.local');
    await app.inject({ method: 'PUT', url: '/api/admin/settings/delivery', headers: h, payload: { minOrderCents: 0, etaMinMinutes: 30, etaMaxMinutes: 50, openMode: 'auto' } });
    const r = await app.inject({ method: 'PUT', url: '/api/admin/settings/hours', headers: h, payload: { shifts: [] } });
    expect(r.statusCode).toBe(200);
    const store = (await app.inject({ method: 'GET', url: '/api/public/store' })).json();
    expect(store.open).toBe(false);
    const bad = await app.inject({ method: 'PUT', url: '/api/admin/settings/hours', headers: h, payload: { shifts: [{ weekday: 1, opensAt: '25:00', closesAt: '23:00' }] } });
    expect(bad.statusCode).toBe(400);
  });

  it('formas de pagamento: pelo menos uma habilitada', async () => {
    const h = await loginAs(app, 'dono@t.local');
    const base = (await app.inject({ method: 'GET', url: '/api/admin/settings', headers: h })).json().settings;
    const res = await app.inject({ method: 'PUT', url: '/api/admin/settings/store', headers: h, payload: { ...base, acceptsCash: false, acceptsPix: false, acceptsCard: false } });
    expect(res.statusCode).toBe(400);
  });
});

describe('pedidos no painel', () => {
  it('fluxo de status, histórico com usuário e transição inválida', async () => {
    await app.inject({ method: 'POST', url: '/api/public/orders', payload: orderBody(f) });
    const h = await loginAs(app, 'atendente@t.local');
    const list = (await app.inject({ method: 'GET', url: '/api/admin/orders?active=1', headers: h })).json();
    expect(list.total).toBe(1);
    const id = list.orders[0].id;
    const st = (status: string, note = '') => app.inject({ method: 'POST', url: `/api/admin/orders/${id}/status`, headers: h, payload: { status, note } });
    expect((await st('confirmed')).statusCode).toBe(200);
    expect((await st('preparing')).statusCode).toBe(200);
    expect((await st('received')).json().error.code).toBe('invalid_transition');
    expect((await st('cancelled', 'cliente desistiu')).json().error.code).toBe('forbidden_cancel');
    const detail = (await app.inject({ method: 'GET', url: `/api/admin/orders/${id}`, headers: h })).json();
    expect(detail.history.map((x: any) => [x.to_status, x.user_name])).toEqual([['received', null], ['confirmed', 'atendente'], ['preparing', 'atendente']]);
  });

  it('cancelamento exige motivo, devolve estoque e mantém o registro', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/public/orders', payload: orderBody(f, { items: [{ productId: f.burgerId, quantity: 2, addonIds: [f.pontoMalId] }, { productId: f.sodaId, quantity: 2, addonIds: [] }] }) });
    expect(res.statusCode).toBe(201);
    const h = await loginAs(app, 'gerente@t.local');
    const id = (await app.inject({ method: 'GET', url: '/api/admin/orders', headers: h })).json().orders[0].id;
    expect((await app.inject({ method: 'POST', url: `/api/admin/orders/${id}/status`, headers: h, payload: { status: 'cancelled' } })).json().error.code).toBe('reason_required');
    expect((await app.inject({ method: 'POST', url: `/api/admin/orders/${id}/status`, headers: h, payload: { status: 'cancelled', note: 'Cliente desistiu' } })).statusCode).toBe(200);
    expect((await pool.query('SELECT stock_qty FROM products WHERE id = $1', [f.sodaId])).rows[0].stock_qty).toBe(3);
    const o = (await pool.query('SELECT status, total_cents, cancel_reason FROM orders WHERE id = $1', [id])).rows[0];
    expect(o).toEqual({ status: 'cancelled', total_cents: 2 * 3000 + 2 * 700 + 600, cancel_reason: 'Cliente desistiu' });
    const job = (await pool.query('SELECT status FROM print_jobs WHERE order_id = $1', [id])).rows[0];
    expect(job.status).toBe('cancelled');
  });

  it('busca por número, telefone e nome', async () => {
    await app.inject({ method: 'POST', url: '/api/public/orders', payload: orderBody(f) });
    await app.inject({ method: 'POST', url: '/api/public/orders', payload: orderBody(f, { customer: { name: 'Maria Souza', phone: '21 99999-1111' } }) });
    const h = await loginAs(app, 'dono@t.local');
    const q = async (s: string) => (await app.inject({ method: 'GET', url: `/api/admin/orders?q=${encodeURIComponent(s)}`, headers: h })).json().orders.map((o: any) => o.number);
    expect(await q('2')).toEqual([2]);
    expect(await q('#1')).toEqual([1]);
    expect(await q('99999-1111')).toEqual([2]);
    expect(await q('maria')).toEqual([2]);
  });
});

describe('usuários', () => {
  it('dono cria usuário com senha forte e não remove o próprio acesso', async () => {
    const h = await loginAs(app, 'dono@t.local');
    const weak = await app.inject({ method: 'POST', url: '/api/admin/users', headers: h, payload: { name: 'Novo', email: 'novo@t.local', role: 'staff', password: '123' } });
    expect(weak.json().error.code).toBe('weak_password');
    const ok = await app.inject({ method: 'POST', url: '/api/admin/users', headers: h, payload: { name: 'Novo', email: 'novo@t.local', role: 'staff', password: 'outraSenha123' } });
    expect(ok.statusCode).toBe(200);
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: h })).json().user.id;
    const self = await app.inject({ method: 'PUT', url: `/api/admin/users/${me}`, headers: h, payload: { name: 'dono', role: 'staff', active: true } });
    expect(self.json().error.code).toBe('self_lockout');
  });
});
