import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seed, makeApp, loginAs } from './helpers.js';

let app: Awaited<ReturnType<typeof makeApp>>;

beforeEach(async () => {
  await resetDb();
  await seed();
  app ??= await makeApp();
});
afterAll(async () => {
  await app.close();
});

const frango = { name: 'Frango desfiado', groupName: 'Carnes', chilledHours: 72, frozenHours: 30 * 24, ambientHours: null, defaultStorage: 'chilled' };

async function createProduct(h: Record<string, string>, body: object = frango) {
  const r = await app.inject({ method: 'POST', url: '/api/admin/labels/products', headers: h, payload: body });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().product;
}

describe('etiquetas de validade', () => {
  it('gerente cadastra produto; atendente não cadastra, mas lista e imprime', async () => {
    const g = await loginAs(app, 'gerente@t.local');
    const p = await createProduct(g);
    const a = await loginAs(app, 'atendente@t.local');
    expect((await app.inject({ method: 'POST', url: '/api/admin/labels/products', headers: a, payload: { ...frango, name: 'X' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: `/api/admin/labels/products/${p.id}`, headers: a, payload: frango })).statusCode).toBe(403);
    const list = (await app.inject({ method: 'GET', url: '/api/admin/labels/products', headers: a })).json();
    expect(list.products.map((x: any) => x.name)).toEqual(['Frango desfiado']);
    expect(list.store.name).toBeTruthy();
    const r = await app.inject({ method: 'POST', url: '/api/admin/labels/prints', headers: a, payload: { productId: p.id, storage: 'chilled', handledAt: new Date().toISOString(), responsible: 'Maria', copies: 2 } });
    expect(r.statusCode, r.body).toBe(200);
  });

  it('valida o cadastro: precisa de pelo menos uma validade e a conservação padrão com prazo', async () => {
    const g = await loginAs(app, 'gerente@t.local');
    const none = await app.inject({ method: 'POST', url: '/api/admin/labels/products', headers: g, payload: { name: 'Molho', chilledHours: null, frozenHours: null, ambientHours: null } });
    expect(none.statusCode).toBe(400);
    const bad = await app.inject({ method: 'POST', url: '/api/admin/labels/products', headers: g, payload: { name: 'Molho', chilledHours: 48, defaultStorage: 'frozen' } });
    expect(bad.statusCode).toBe(400);
    await createProduct(g);
    const dup = await app.inject({ method: 'POST', url: '/api/admin/labels/products', headers: g, payload: { ...frango, name: 'FRANGO DESFIADO' } });
    expect(dup.json().error.code).toBe('duplicate_name');
  });

  it('calcula a validade pela conservação e gera lotes em sequência no dia', async () => {
    const g = await loginAs(app, 'gerente@t.local');
    const p = await createProduct(g);
    const print = async (payload: object) => {
      const r = await app.inject({ method: 'POST', url: '/api/admin/labels/prints', headers: g, payload: { productId: p.id, handledAt: new Date(Date.now() - 3600_000).toISOString(), responsible: 'João', ...payload } });
      expect(r.statusCode, r.body).toBe(200);
      return r.json().print;
    };
    const handled = new Date(Date.now() - 3600_000);
    const chilled = await print({ storage: 'chilled', handledAt: handled.toISOString() });
    expect(new Date(chilled.expiresAt).getTime() - handled.getTime()).toBe(72 * 3600_000);
    const frozen = await print({ storage: 'frozen', handledAt: handled.toISOString(), quantityText: '2 kg' });
    expect(new Date(frozen.expiresAt).getTime() - handled.getTime()).toBe(30 * 24 * 3600_000);
    expect(frozen.quantityText).toBe('2 kg');
    expect(chilled.lot).toMatch(/^\d{6}-001$/);
    expect(frozen.lot).toBe(chilled.lot.replace(/001$/, '002'));
    expect(chilled.productName).toBe('Frango desfiado');

    // Conservação sem prazo cadastrado exige validade manual.
    const amb = await app.inject({ method: 'POST', url: '/api/admin/labels/prints', headers: g, payload: { productId: p.id, storage: 'ambient', handledAt: handled.toISOString(), responsible: 'João' } });
    expect(amb.json().error.code).toBe('missing_expiry');
    const manual = new Date(handled.getTime() + 5 * 3600_000).toISOString();
    const ok = await print({ storage: 'ambient', handledAt: handled.toISOString(), manualExpiresAt: manual });
    expect(ok.expiresAt).toBe(manual);
  });

  it('produto avulso (sem cadastro) exige nome e validade; validade antes da manipulação é recusada', async () => {
    const a = await loginAs(app, 'atendente@t.local');
    const handled = new Date(Date.now() - 60_000);
    const base = { storage: 'chilled', handledAt: handled.toISOString(), responsible: 'Ana' };
    expect((await app.inject({ method: 'POST', url: '/api/admin/labels/prints', headers: a, payload: { ...base, manualExpiresAt: new Date(Date.now() + 3600_000).toISOString() } })).json().error.code).toBe('missing_product');
    expect((await app.inject({ method: 'POST', url: '/api/admin/labels/prints', headers: a, payload: { ...base, productName: 'Maionese' } })).json().error.code).toBe('missing_expiry');
    const before = await app.inject({ method: 'POST', url: '/api/admin/labels/prints', headers: a, payload: { ...base, productName: 'Maionese', manualExpiresAt: new Date(handled.getTime() - 1000).toISOString() } });
    expect(before.json().error.code).toBe('expiry_before_handled');
    const future = await app.inject({ method: 'POST', url: '/api/admin/labels/prints', headers: a, payload: { ...base, productName: 'Maionese', handledAt: new Date(Date.now() + 3 * 24 * 3600_000).toISOString(), manualExpiresAt: new Date(Date.now() + 9 * 24 * 3600_000).toISOString() } });
    expect(future.json().error.code).toBe('handled_in_future');
    const ok = await app.inject({ method: 'POST', url: '/api/admin/labels/prints', headers: a, payload: { ...base, productName: 'Maionese', labelType: 'opened', manualExpiresAt: new Date(Date.now() + 3600_000).toISOString() } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().print).toMatchObject({ productName: 'Maionese', labelType: 'opened', productId: null, printedByName: 'atendente' });
  });

  it('controle de vencimento: resumo, ordem por validade e baixa por uso ou descarte', async () => {
    const g = await loginAs(app, 'gerente@t.local');
    const mk = async (name: string, handledMinAgo: number, expiresInMin: number) =>
      (await app.inject({ method: 'POST', url: '/api/admin/labels/prints', headers: g, payload: {
        productName: name, storage: 'chilled', responsible: 'João',
        handledAt: new Date(Date.now() - handledMinAgo * 60_000).toISOString(),
        manualExpiresAt: new Date(Date.now() + expiresInMin * 60_000).toISOString(),
      } })).json().print;
    const vencido = await mk('Vencido', 120, -30);
    const hoje = await mk('Vence hoje', 10, 120);
    const longe = await mk('Longe', 10, 5 * 24 * 60);
    const list = (await app.inject({ method: 'GET', url: '/api/admin/labels/prints', headers: g })).json();
    expect(list.prints.map((p: any) => p.productName)).toEqual(['Vencido', 'Vence hoje', 'Longe']);
    expect(list.summary).toEqual({ expired: 1, expiring: 1, active: 3 });

    const noReason = await app.inject({ method: 'POST', url: `/api/admin/labels/prints/${vencido.id}/close`, headers: g, payload: { status: 'discarded' } });
    expect(noReason.json().error.code).toBe('missing_reason');
    expect((await app.inject({ method: 'POST', url: `/api/admin/labels/prints/${vencido.id}/close`, headers: g, payload: { status: 'discarded', reason: 'Venceu' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/admin/labels/prints/${hoje.id}/close`, headers: g, payload: { status: 'used' } })).statusCode).toBe(200);
    // Baixa duplicada não passa.
    expect((await app.inject({ method: 'POST', url: `/api/admin/labels/prints/${hoje.id}/close`, headers: g, payload: { status: 'used' } })).statusCode).toBe(404);

    const after = (await app.inject({ method: 'GET', url: '/api/admin/labels/prints', headers: g })).json();
    expect(after.prints.map((p: any) => p.id)).toEqual([longe.id]);
    const all = (await app.inject({ method: 'GET', url: '/api/admin/labels/prints?status=all&q=venc', headers: g })).json();
    expect(all.prints.map((p: any) => [p.productName, p.status]).sort()).toEqual([['Vence hoje', 'used'], ['Vencido', 'discarded']]);
    const responsibles = (await app.inject({ method: 'GET', url: '/api/admin/labels/products', headers: g })).json().responsibles;
    expect(responsibles).toEqual(['João']);
  });

  it('exige login', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/labels/products' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/admin/labels/prints' })).statusCode).toBe(401);
  });
});
