import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seed, makeApp, orderBody, pool, type Fixture } from './helpers.js';

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

const post = (payload: any) => app.inject({ method: 'POST', url: '/api/public/orders', payload });

describe('cardápio público', () => {
  it('lista só ativos, marca indisponíveis e aplica promoção', async () => {
    await pool.query(`UPDATE products SET active = false WHERE name = 'Refri'`);
    const res = await app.inject({ method: 'GET', url: '/api/public/menu' });
    const prods = res.json().categories[0].products;
    expect(prods.map((p: any) => p.name)).toEqual(['Burger', 'Duplo', 'Esgotado']);
    expect(prods.find((p: any) => p.name === 'Esgotado').available).toBe(false);
    expect(prods.find((p: any) => p.name === 'Duplo').effectivePriceCents).toBe(3500);
  });
  it('dados da loja só listam bairros atendidos', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/public/store' });
    expect(res.json().neighborhoods.map((n: any) => n.name)).toEqual(['Centro']);
    expect(res.json().open).toBe(true);
  });
});

describe('criação do pedido', () => {
  it('calcula tudo no servidor e grava cópia dos itens', async () => {
    const res = await post(orderBody(f));
    expect(res.statusCode).toBe(201);
    const { number, token } = res.json();
    expect(number).toBe(1);
    const o = (await pool.query('SELECT * FROM orders WHERE public_token = $1', [token])).rows[0];
    // 2 x (3000 + bacon 500) = 7000; taxa 600
    expect([o.subtotal_cents, o.delivery_fee_cents, o.total_cents]).toEqual([7000, 600, 7600]);
    expect(o.customer_phone).toBe('11987654321');
    const items = (await pool.query('SELECT * FROM order_items WHERE order_id = $1', [o.id])).rows;
    expect(items[0]).toMatchObject({ product_name: 'Burger', unit_price_cents: 3000, addons_unit_cents: 500, quantity: 2, line_total_cents: 7000 });
    const addons = (await pool.query('SELECT addon_name FROM order_item_addons WHERE order_item_id = $1 ORDER BY addon_name', [items[0].id])).rows;
    expect(addons.map((a) => a.addon_name)).toEqual(['Ao ponto', 'Bacon']);
    // alteração posterior do produto não muda o pedido
    await pool.query(`UPDATE products SET name = 'Burger Novo', price_cents = 9999 WHERE id = $1`, [f.burgerId]);
    const again = (await pool.query('SELECT product_name, unit_price_cents FROM order_items WHERE order_id = $1', [o.id])).rows[0];
    expect(again).toEqual({ product_name: 'Burger', unit_price_cents: 3000 });
    // fila de impressão e histórico
    const job = (await pool.query('SELECT kind, status FROM print_jobs WHERE order_id = $1', [o.id])).rows;
    expect(job).toEqual([{ kind: 'original', status: 'pending' }]);
    expect(o.print_status).toBe('pending');
  });

  it('ignora preços enviados pelo navegador', async () => {
    const body: any = orderBody(f);
    body.items[0].priceCents = 1;
    body.totalCents = 1;
    const res = await post(body);
    expect(res.statusCode).toBe(201);
    expect(res.json().totalCents).toBe(7600);
  });

  it('aplica promoção válida', async () => {
    const res = await post(orderBody(f, { items: [{ productId: f.duploId, quantity: 1, addonIds: [] }] }));
    expect(res.json().totalCents).toBe(3500 + 600);
  });

  it('mesmo envio repetido não duplica (idempotência)', async () => {
    const body = orderBody(f);
    const results = await Promise.all([post(body), post(body), post(body)]);
    const numbers = new Set(results.map((r) => r.json().number));
    expect(numbers.size).toBe(1);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    const count = (await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
    expect(count).toBe(1);
    const jobs = (await pool.query('SELECT count(*)::int AS n FROM print_jobs')).rows[0].n;
    expect(jobs).toBe(1);
  });

  it('mesma chave com dados diferentes é recusada', async () => {
    const body = orderBody(f);
    await post(body);
    const res = await post({ ...body, notes: 'outra coisa' });
    expect(res.statusCode).toBe(409);
  });

  it('bloqueia produto indisponível', async () => {
    const res = await post(orderBody(f, { items: [{ productId: f.esgotadoId, quantity: 1, addonIds: [] }] }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('product_unavailable');
  });

  it('exige adicional obrigatório e respeita máximo', async () => {
    let res = await post(orderBody(f, { items: [{ productId: f.burgerId, quantity: 1, addonIds: [f.baconId] }] }));
    expect(res.json().error.code).toBe('addon_required');
    res = await post(orderBody(f, { items: [{ productId: f.burgerId, quantity: 1, addonIds: [f.pontoMalId, f.pontoAoPontoId] }] }));
    expect(res.json().error.code).toBe('addon_limit');
  });

  it('recusa bairro não atendido', async () => {
    const res = await post(orderBody(f, { address: { street: 'Rua', number: '1', neighborhoodId: f.hoodOffId } }));
    expect(res.json().error.code).toBe('area_not_served');
  });

  it('respeita pedido mínimo', async () => {
    const res = await post(orderBody(f, { items: [{ productId: f.sodaId, quantity: 1, addonIds: [] }] }));
    expect(res.json().error.code).toBe('below_minimum');
  });

  it('bloqueia pedidos com a loja fechada', async () => {
    await pool.query(`UPDATE store_settings SET open_mode = 'force_closed'`);
    const res = await post(orderBody(f));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('store_closed');
  });

  it('valida troco, telefone e forma de pagamento', async () => {
    expect((await post(orderBody(f, { payment: { method: 'cash', changeForCents: 5000 } }))).json().error.code).toBe('invalid_change');
    expect((await post(orderBody(f, { customer: { name: 'Ana', phone: '1234-5678' } }))).json().error.code).toBe('invalid_phone');
    await pool.query('UPDATE store_settings SET accepts_pix = false');
    expect((await post(orderBody(f, { payment: { method: 'pix' } }))).json().error.code).toBe('payment_not_accepted');
    const missing = await post({ ...orderBody(f), acceptPrivacy: false });
    expect(missing.json().error.code).toBe('validation_error');
  });

  it('controla estoque e não vende além do disponível', async () => {
    const items = [{ productId: f.burgerId, quantity: 1, addonIds: [f.pontoMalId] }, { productId: f.sodaId, quantity: 3, addonIds: [] }];
    expect((await post(orderBody(f, { items }))).statusCode).toBe(201);
    expect((await pool.query('SELECT stock_qty FROM products WHERE id = $1', [f.sodaId])).rows[0].stock_qty).toBe(0);
    const res = await post(orderBody(f, { items: [{ productId: f.burgerId, quantity: 1, addonIds: [f.pontoMalId] }, { productId: f.sodaId, quantity: 1, addonIds: [] }] }));
    expect(res.json().error.code).toBe('out_of_stock');
  });

  it('nada fica gravado pela metade quando algo falha', async () => {
    // Faz o insert do histórico falhar removendo a tabela dentro do teste.
    await pool.query('ALTER TABLE order_status_history RENAME TO osh_tmp');
    const res = await post(orderBody(f));
    await pool.query('ALTER TABLE osh_tmp RENAME TO order_status_history');
    expect(res.statusCode).toBe(500);
    const counts = (await pool.query(`SELECT (SELECT count(*) FROM orders)::int o, (SELECT count(*) FROM order_items)::int i, (SELECT count(*) FROM print_jobs)::int j`)).rows[0];
    expect(counts).toEqual({ o: 0, i: 0, j: 0 });
  });

  it('cliente acompanha só com o token', async () => {
    const { token } = (await post(orderBody(f))).json();
    const ok = await app.inject({ method: 'GET', url: `/api/public/orders/${token}` });
    expect(ok.json()).toMatchObject({ number: 1, status: 'received', totalCents: 7600 });
    const bad = await app.inject({ method: 'GET', url: `/api/public/orders/${'x'.repeat(32)}` });
    expect(bad.statusCode).toBe(404);
  });

  it('prévia do carrinho usa a mesma regra', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/public/quote',
      payload: { items: orderBody(f).items, neighborhoodId: f.hoodAId },
    });
    expect(res.json()).toMatchObject({ subtotalCents: 7000, deliveryFeeCents: 600, totalCents: 7600, belowMinimum: false });
  });
});

describe('bairro pelo CEP (fora da lista)', () => {
  const unlisted = (name: string, city = 'São Paulo') => ({ cep: '01310-100', street: 'Avenida Paulista', number: '1000', neighborhoodName: name, city });

  it('cria o bairro com taxa a definir e o pedido sai com taxa a combinar', async () => {
    const q = await app.inject({ method: 'POST', url: '/api/public/quote', payload: { items: orderBody(f).items, neighborhoodName: 'Bela Vista', city: 'São Paulo' } });
    expect(q.json()).toMatchObject({ deliveryFeeCents: 0, deliveryFeePending: true, totalCents: 7000 });
    expect((await pool.query('SELECT count(*)::int c FROM neighborhoods')).rows[0].c).toBe(2); // a prévia não cria nada

    const res = await post(orderBody(f, { address: unlisted('Bela Vista') }));
    expect(res.statusCode).toBe(201);
    const o = (await pool.query('SELECT * FROM orders WHERE public_token = $1', [res.json().token])).rows[0];
    expect(o).toMatchObject({ neighborhood_name: 'Bela Vista', delivery_fee_cents: 0, delivery_fee_pending: true, total_cents: 7000 });
    const hood = (await pool.query(`SELECT * FROM neighborhoods WHERE name = 'Bela Vista'`)).rows[0];
    expect(hood).toMatchObject({ fee_cents: 0, fee_pending: true, active: true, city: 'São Paulo' });
    const status = await app.inject({ method: 'GET', url: `/api/public/orders/${res.json().token}` });
    expect(status.json().deliveryFeePending).toBe(true);

    // Segundo pedido do mesmo bairro (grafia diferente) reaproveita o cadastro.
    expect((await post(orderBody(f, { address: unlisted('bela  vísta') }))).statusCode).toBe(201);
    expect((await pool.query(`SELECT count(*)::int c FROM neighborhoods`)).rows[0].c).toBe(3);
  });

  it('nome que bate com bairro cadastrado usa a taxa dele', async () => {
    const res = await post(orderBody(f, { address: unlisted('CENTRO', '') }));
    const o = (await pool.query('SELECT * FROM orders WHERE public_token = $1', [res.json().token])).rows[0];
    expect(o).toMatchObject({ delivery_fee_cents: 600, delivery_fee_pending: false });
  });

  it('bairro desativado continua recusado, e a loja pode desligar a opção', async () => {
    expect((await post(orderBody(f, { address: unlisted('Longe', '') }))).json().error.code).toBe('area_not_served');
    await pool.query('UPDATE store_settings SET accept_unlisted_neighborhoods = false');
    expect((await post(orderBody(f, { address: unlisted('Bela Vista') }))).json().error.code).toBe('area_not_served');
    expect((await pool.query(`SELECT count(*)::int c FROM neighborhoods`)).rows[0].c).toBe(2);
  });
});
