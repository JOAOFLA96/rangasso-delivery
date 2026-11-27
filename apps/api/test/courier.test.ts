import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seed, makeApp, orderBody, loginAs, pool, type Fixture } from './helpers.js';
import { setTripPlanner } from '../src/services/google.js';

let app: Awaited<ReturnType<typeof makeApp>>;
let f: Fixture;
let owner: Record<string, string>;
let staff: Record<string, string>;

beforeEach(async () => {
  await resetDb();
  f = await seed();
  app ??= await makeApp();
  owner = await loginAs(app, 'dono@t.local');
  staff = await loginAs(app, 'atendente@t.local');
  await pool.query(`UPDATE store_settings SET address = 'Av. Itororó, 681 - Cidade Nova I, Indaiatuba - SP, 13334-050'`);
  setTripPlanner(async (_o, stops) => ({ order: stops.map((_, i) => i), meters: 1000, seconds: 300, legs: [...stops, 'v'].map(() => ({ meters: 500, seconds: 100 })) }));
});
afterEach(() => setTripPlanner(null));
afterAll(async () => {
  await app.close();
});

const admin = (method: string, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method: method as any, url: `/api/admin${url}`, headers, payload: payload as any });
const courierApi = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url: `/api/courier${url}`, payload: payload as any });

async function newOrder(street: string, payment: any = { method: 'cash', changeForCents: 10000 }) {
  const res = await app.inject({ method: 'POST', url: '/api/public/orders', payload: orderBody(f, { payment, address: { cep: '13334-050', street, number: '1', neighborhoodId: f.hoodAId } }) });
  const o = (await pool.query('SELECT id, number, total_cents FROM orders WHERE public_token = $1', [res.json().token])).rows[0];
  await admin('POST', `/orders/${o.id}/status`, staff, { status: 'preparing' }); // entra sozinho na saída do motoboy
  return o as { id: string; number: number; total_cents: number };
}

describe('página do motoboy', () => {
  it('link pessoal: vê só a rota dele, sai, avisa que está chegando, dá baixa e volta', async () => {
    const carlos = (await admin('POST', '/couriers', owner, { name: 'Carlos', phone: '19998765432' })).json().id;
    const ze = (await admin('POST', '/couriers', owner, { name: 'Zé' })).json().id;
    expect((await admin('POST', `/couriers/${carlos}/link`, staff)).statusCode).toBe(403);
    const token = (await admin('POST', `/couriers/${carlos}/link`, owner)).json().accessToken as string;
    const zeToken = (await admin('POST', `/couriers/${ze}/link`, owner)).json().accessToken as string;
    // Atendente não vê o link; gerente/dono vê.
    expect((await admin('GET', '/couriers', staff)).json().couriers[0].accessToken).toBeUndefined();
    expect((await admin('GET', '/couriers', owner)).json().couriers.find((c: any) => c.id === carlos).accessToken).toBe(token);

    const a = await newOrder('Rua A');
    const b = await newOrder('Rua B', { method: 'card' });
    let page = (await courierApi('GET', `/${token}`)).json();
    expect(page.courier.name).toBe('Carlos');
    expect(page.runs).toHaveLength(1);
    const run = page.runs[0];
    expect(run.stops.map((s: any) => s.number)).toEqual([a.number, b.number]);
    // O outro motoboy não enxerga nem mexe nessa saída.
    expect((await courierApi('GET', `/${zeToken}`)).json().runs).toEqual([]);
    expect((await courierApi('POST', `/${zeToken}/runs/${run.id}/depart`)).statusCode).toBe(404);
    expect((await courierApi('GET', '/tokeninvalidotokeninvalido')).statusCode).toBe(404);

    expect((await courierApi('POST', `/${token}/runs/${run.id}/stops/${a.id}/arriving`)).statusCode).toBe(400); // ainda não saiu
    expect((await courierApi('POST', `/${token}/location`, { lat: -23.1, lng: -47.2 })).statusCode).toBe(409); // ainda na loja: não rastreia
    expect((await courierApi('POST', `/${token}/runs/${run.id}/depart`)).statusCode).toBe(200);
    expect((await courierApi('POST', `/${token}/location`, { lat: -23.1, lng: -47.2, accuracy: 12.4 })).statusCode).toBe(200);
    const live = (await admin('GET', '/delivery-runs', staff)).json().runs.find((r: any) => r.id === run.id);
    expect(live.courierLocation).toMatchObject({ lat: -23.1, lng: -47.2, accuracyM: 12 });
    expect((await pool.query('SELECT status FROM orders WHERE id = $1', [a.id])).rows[0].status).toBe('out_for_delivery');
    expect((await courierApi('POST', `/${token}/runs/${run.id}/stops/${a.id}/arriving`)).statusCode).toBe(200);
    expect((await courierApi('POST', `/${token}/runs/${run.id}/stops/${a.id}`, { outcome: 'delivered' })).statusCode).toBe(200);
    expect((await courierApi('POST', `/${token}/runs/${run.id}/stops/${b.id}`, { outcome: 'not_delivered', note: 'Cliente não atendeu' })).statusCode).toBe(200);
    page = (await courierApi('GET', `/${token}`)).json();
    expect(page.runs[0].stops[0]).toMatchObject({ outcome: 'delivered', outcomeBy: 'courier' });
    expect(page.runs[0].stops[0].arrivingAt).toBeTruthy();
    expect(page.today).toMatchObject({ delivered: 1, not_delivered: 1, cash_cents: a.total_cents, card_cents: 0, runs: 1 });
    expect((await courierApi('POST', `/${token}/runs/${run.id}/finish`)).statusCode).toBe(200);
    expect((await courierApi('POST', `/${token}/location`, { lat: -23.1, lng: -47.2 })).statusCode).toBe(409); // voltou: parou
    expect((await courierApi('GET', `/${token}`)).json().runs).toEqual([]);
    const h = (await pool.query(`SELECT to_status, changed_by FROM order_status_history WHERE order_id = $1 ORDER BY created_at`, [a.id])).rows;
    expect(h.at(-1)).toMatchObject({ to_status: 'completed', changed_by: null });

    // Gerar de novo invalida o link antigo; motoboy desativado perde o acesso.
    const novo = (await admin('POST', `/couriers/${carlos}/link`, owner)).json().accessToken;
    expect((await courierApi('GET', `/${token}`)).statusCode).toBe(404);
    await admin('PUT', `/couriers/${carlos}`, owner, { name: 'Carlos', phone: '', active: false });
    expect((await courierApi('GET', `/${novo}`)).statusCode).toBe(404);
  });

  it('QR do cupom: motoboy pega o pedido, troca com outro só confirmando e a rota é refeita', async () => {
    await pool.query('UPDATE store_settings SET auto_dispatch = false');
    const carlos = (await admin('POST', '/couriers', owner, { name: 'Carlos' })).json().id;
    const ze = (await admin('POST', '/couriers', owner, { name: 'Zé' })).json().id;
    const token = (await admin('POST', `/couriers/${carlos}/link`, owner)).json().accessToken as string;
    const a = await newOrder('Rua A');
    const b = await newOrder('Rua B');
    const c = await newOrder('Rua C');
    // Cupom traz o link do QR.
    const payload = (await pool.query(`SELECT payload FROM print_jobs WHERE order_id = $1`, [a.id])).rows[0].payload;
    expect(payload.courierQr).toMatch(new RegExp(`/motoboy/pegar/${a.id}$`));

    const zeRun = (await admin('POST', '/delivery-runs', owner, { courierId: ze, orderIds: [a.id] })).json().id;
    let res = await courierApi('POST', `/${token}/claim`, { orderId: a.id });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'confirm_swap', details: { from: 'Zé' } });
    res = await courierApi('POST', `/${token}/claim`, { orderId: a.id, confirm: true });
    expect(res.json()).toMatchObject({ ok: true, from: 'Zé', already: false });
    expect((await pool.query('SELECT status FROM delivery_runs WHERE id = $1', [zeRun])).rows[0].status).toBe('cancelled');
    // Pelo número digitado, entra na mesma saída; ler de novo não duplica.
    expect((await courierApi('POST', `/${token}/claim`, { number: String(b.number) })).json()).toMatchObject({ ok: true, from: null });
    expect((await courierApi('POST', `/${token}/claim`, { orderId: b.id })).json()).toMatchObject({ already: true });
    const page = (await courierApi('GET', `/${token}`)).json();
    expect(page.runs).toHaveLength(1);
    expect(page.runs[0].stops.map((s: any) => s.number).sort()).toEqual([a.number, b.number].sort());
    expect((await pool.query('SELECT auto_dispatch_skip FROM orders WHERE id = $1', [b.id])).rows[0].auto_dispatch_skip).toBe(true);

    // Pedido que já saiu com outro motoboy não pode ser pego.
    const zeRun2 = (await admin('POST', '/delivery-runs', owner, { courierId: ze, orderIds: [c.id] })).json().id;
    await admin('POST', `/delivery-runs/${zeRun2}/depart`, owner);
    res = await courierApi('POST', `/${token}/claim`, { orderId: c.id, confirm: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('order_out');
    expect((await courierApi('POST', `/${token}/claim`, {})).statusCode).toBe(400);
    expect((await courierApi('POST', `/${token}/claim`, { number: 999999 })).statusCode).toBe(404);
  });
  it('QR lido em qualquer ordem: a rota do motoboy é reordenada pela melhor sequência do Google', async () => {
    // Google falso: a melhor ordem é a da rua com nome "maior" primeiro (Rua C, Rua B, Rua A).
    const asked: boolean[] = [];
    setTripPlanner(async (_o, stops, optimize) => {
      asked.push(optimize);
      const order = stops.map((_, i) => i).sort((x, y) => (optimize ? stops[y].localeCompare(stops[x]) : x - y));
      return { order, meters: 1000, seconds: 300, legs: [...stops, 'v'].map(() => ({ meters: 500, seconds: 100 })) };
    });
    await pool.query('UPDATE store_settings SET auto_dispatch = false');
    const carlos = (await admin('POST', '/couriers', owner, { name: 'Carlos' })).json().id;
    const token = (await admin('POST', `/couriers/${carlos}/link`, owner)).json().accessToken as string;
    const a = await newOrder('Rua A');
    const b = await newOrder('Rua B');
    const c = await newOrder('Rua C');
    for (const o of [a, c, b]) expect((await courierApi('POST', `/${token}/claim`, { orderId: o.id, confirm: true })).statusCode).toBe(200);
    const run = (await courierApi('GET', `/${token}`)).json().runs[0];
    expect(run.stops.map((s: any) => s.number)).toEqual([c.number, b.number, a.number]);
    expect(asked).toContain(true);
    // O link do Google Maps segue a mesma ordem otimizada.
    const u = new URL(run.mapsUrl as string);
    const seq = [...(u.searchParams.get('waypoints') ?? '').split('|'), u.searchParams.get('destination')!].map((x) => x.split(',')[0]);
    expect(seq).toEqual(['Rua C', 'Rua B', 'Rua A']);
  });
  it('rota de ida e volta: fica com o sentido que entrega mais cedo (mais perto primeiro)', async () => {
    // Paradas numa linha saindo da loja: Rua A a 1 min, Rua B a 2 min, Rua C a 3 min. O "Google" devolve o sentido C, B, A.
    const pos = (addr: string) => ({ A: 1, B: 2, C: 3 } as Record<string, number>)[addr.split(',')[0].slice(-1)];
    let calls = 0;
    setTripPlanner(async (_o, stops, optimize) => {
      calls++;
      const order = optimize ? stops.map((_, i) => i).sort((x, y) => pos(stops[y]) - pos(stops[x])) : stops.map((_, i) => i);
      const seq = [0, ...order.map((i) => pos(stops[i])), 0];
      const legs = seq.slice(1).map((p, i) => ({ meters: 1000, seconds: Math.abs(p - seq[i]) * 60 }));
      return { order, meters: 1000, seconds: legs.reduce((a, l) => a + l.seconds, 0), legs };
    });
    await pool.query('UPDATE store_settings SET auto_dispatch = false');
    const carlos = (await admin('POST', '/couriers', owner, { name: 'Carlos' })).json().id;
    const token = (await admin('POST', `/couriers/${carlos}/link`, owner)).json().accessToken as string;
    const c = await newOrder('Rua C');
    const a = await newOrder('Rua A');
    const b = await newOrder('Rua B');
    for (const o of [c, a, b]) await courierApi('POST', `/${token}/claim`, { orderId: o.id, confirm: true });
    const run = (await courierApi('GET', `/${token}`)).json().runs[0];
    expect(run.stops.map((s: any) => s.number)).toEqual([a.number, b.number, c.number]);
    expect(run.stops.map((s: any) => s.etaOffsetS)).toEqual([60, 120, 180]);
    expect(calls).toBeGreaterThan(1);
  });
});
