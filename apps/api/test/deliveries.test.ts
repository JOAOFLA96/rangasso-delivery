import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seed, makeApp, orderBody, loginAs, pool, type Fixture } from './helpers.js';
import { setTripPlanner, type TripFn } from '../src/services/google.js';
import { cityOf, mapsUrl } from '../src/services/deliveryRuns.js';

let app: Awaited<ReturnType<typeof makeApp>>;
let f: Fixture;
let staff: Record<string, string>;
let owner: Record<string, string>;
let tripCalls: { stops: string[]; optimize: boolean }[] = [];

// Google falso: otimizando, inverte a ordem; cada trecho 1 km / 3 min.
const fakeTrip: TripFn = async (_origin, stops, optimize) => {
  tripCalls.push({ stops, optimize });
  const order = stops.map((_, i) => i);
  if (optimize) order.reverse();
  const legs = [...stops, 'volta'].map(() => ({ meters: 1000, seconds: 180 }));
  return { order, legs, meters: 1000 * legs.length, seconds: 180 * legs.length };
};

beforeEach(async () => {
  await resetDb();
  f = await seed();
  app ??= await makeApp();
  staff = await loginAs(app, 'atendente@t.local');
  owner = await loginAs(app, 'dono@t.local');
  await pool.query(`UPDATE store_settings SET address = 'Av. Itororó, 681 - Cidade Nova I, Indaiatuba - SP, 13334-050'`);
  tripCalls = [];
  setTripPlanner(fakeTrip);
});
afterEach(() => setTripPlanner(null));
afterAll(async () => {
  await app.close();
});

const call = (method: string, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method: method as any, url: `/api/admin${url}`, headers, payload: payload as any });

async function newOrder(street: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST', url: '/api/public/orders',
    payload: orderBody(f, { address: { cep: '13334-050', street, number: '10', neighborhoodId: f.hoodAId, complement: '', reference: '' }, ...extra }),
  });
  expect(res.statusCode).toBe(201);
  return (await pool.query('SELECT id, number FROM orders WHERE public_token = $1', [res.json().token])).rows[0] as { id: string; number: number };
}
async function courier(name = 'Carlos', phone = '(19) 99876-5432') {
  const r = await call('POST', '/couriers', owner, { name, phone });
  expect(r.statusCode).toBe(200);
  return r.json().id as string;
}
const active = async () => (await call('GET', '/delivery-runs', staff)).json().runs;

describe('motoboys', () => {
  it('dono cadastra; atendente não', async () => {
    const id = await courier();
    expect((await call('POST', '/couriers', staff, { name: 'Outro' })).statusCode).toBe(403);
    expect((await call('POST', '/couriers', owner, { name: 'carlos' })).statusCode).toBe(409);
    expect((await call('POST', '/couriers', owner, { name: 'Zé', phone: '123' })).statusCode).toBe(400);
    expect((await call('PUT', `/couriers/${id}`, owner, { name: 'Carlos', phone: '', active: false })).statusCode).toBe(200);
    const list = (await call('GET', '/couriers', staff)).json().couriers;
    expect(list).toEqual([{ id, name: 'Carlos', phone: '', active: false }]);
  });
});

describe('saídas para entrega', () => {
  it('monta a rota pelo Google, sai, dá baixa e volta', async () => {
    const c = await courier();
    const a = await newOrder('Rua A');
    const b = await newOrder('Rua B');
    const pickup = await app.inject({ method: 'POST', url: '/api/public/orders', payload: orderBody(f, { fulfillment: 'pickup', address: null }) });
    expect(pickup.statusCode).toBe(201);

    const av = (await call('GET', '/deliveries/available', staff)).json();
    expect(av.orders.map((o: any) => o.number)).toEqual([a.number, b.number]); // retirada fica de fora
    expect(av.google).toBe(true);

    const created = await call('POST', '/delivery-runs', staff, { courierId: c, orderIds: [a.id, b.id] });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ number: 1, routeBy: 'google', routeError: null });
    expect(tripCalls[0].optimize).toBe(true);
    expect(tripCalls[0].stops[0]).toContain('Rua A, 10');
    expect(tripCalls[0].stops[0]).toContain('13334-050');

    let [run] = await active();
    expect(run).toMatchObject({ status: 'planned', courierName: 'Carlos', totalDistanceM: 3000, totalDurationS: 540 });
    expect(run.stops.map((s: any) => s.number)).toEqual([b.number, a.number]); // ordem do Google
    expect(run.stops.map((s: any) => s.etaOffsetS)).toEqual([180, 360]);
    expect(run.mapsUrl).toContain('waypoints=Rua+B');
    expect(run.mapsUrl).toContain('destination=Rua+A');
    // Os pedidos saem da lista de disponíveis e não entram em outra saída.
    expect((await call('GET', '/deliveries/available', staff)).json().orders).toEqual([]);
    expect((await call('POST', '/delivery-runs', staff, { courierId: c, orderIds: [a.id] })).statusCode).toBe(409);

    // Antes de sair, não há baixa.
    expect((await call('POST', `/delivery-runs/${run.id}/stops/${a.id}`, staff, { outcome: 'delivered' })).statusCode).toBe(400);

    const dep = await call('POST', `/delivery-runs/${run.id}/depart`, staff);
    expect(dep.json()).toEqual({ ok: true, updated: 2 });
    const st = (await pool.query('SELECT status FROM orders WHERE id = ANY($1) ', [[a.id, b.id]])).rows.map((r) => r.status);
    expect(st).toEqual(['out_for_delivery', 'out_for_delivery']);
    expect((await call('PUT', `/delivery-runs/${run.id}`, staff, { orderIds: [a.id] })).statusCode).toBe(400); // já saiu

    expect((await call('POST', `/delivery-runs/${run.id}/stops/${b.id}`, staff, { outcome: 'delivered' })).statusCode).toBe(200);
    expect((await call('POST', `/delivery-runs/${run.id}/stops/${b.id}`, staff, { outcome: 'delivered' })).statusCode).toBe(400); // já teve baixa
    // Voltar sem dar baixa em todos: recusado.
    const early = await call('POST', `/delivery-runs/${run.id}/finish`, staff);
    expect(early.statusCode).toBe(400);
    expect(early.json().error.message).toContain(`#${a.number}`);
    // Não entregue precisa de motivo e devolve o pedido para outra saída.
    expect((await call('POST', `/delivery-runs/${run.id}/stops/${a.id}`, staff, { outcome: 'not_delivered' })).statusCode).toBe(400);
    expect((await call('POST', `/delivery-runs/${run.id}/stops/${a.id}`, staff, { outcome: 'not_delivered', note: 'cliente não atendeu' })).statusCode).toBe(200);

    [run] = await active();
    expect(run.mapsUrl).toBeNull(); // nada mais a entregar
    expect((await call('POST', `/delivery-runs/${run.id}/finish`, staff)).statusCode).toBe(200);
    expect(await active()).toEqual([]);

    const orders = (await pool.query('SELECT id, status, delivery_run_id FROM orders WHERE id = ANY($1)', [[a.id, b.id]])).rows;
    expect(orders.find((o) => o.id === b.id)).toMatchObject({ status: 'completed' });
    expect(orders.find((o) => o.id === a.id)).toMatchObject({ status: 'out_for_delivery', delivery_run_id: null });
    const again = (await call('GET', '/deliveries/available', staff)).json().orders;
    expect(again).toMatchObject([{ id: a.id, failed_attempts: 1 }]);

    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const sum = (await call('GET', `/delivery-runs/summary?from=${today}&to=${today}`, staff)).json();
    expect(sum.couriers).toMatchObject([{ courier_name: 'Carlos', runs: 1, delivered: 1, not_delivered: 1, planned_distance_m: 3000, delivery_fees_cents: 600 }]);
    expect(sum.couriers[0].avg_ride_min).toBe(0);
    const day = (await call('GET', `/delivery-runs?date=${today}`, staff)).json().runs;
    expect(day).toMatchObject([{ number: 1, status: 'done' }]);
    expect((await call('GET', `/delivery-runs?from=${today}&to=${today}&courierId=${c}`, staff)).json().runs).toHaveLength(1);
    const other = await courier('Outro');
    expect((await call('GET', `/delivery-runs?from=${today}&to=${today}&courierId=${other}`, staff)).json().runs).toEqual([]);
  });

  it('reordenar no painel mede sem otimizar; desfazer libera os pedidos', async () => {
    const a = await newOrder('Rua A');
    const b = await newOrder('Rua B');
    const c = await newOrder('Rua C');
    const id = (await call('POST', '/delivery-runs', staff, { courierId: null, orderIds: [a.id, b.id] })).json().id;
    // Sem motoboy não sai.
    expect((await call('POST', `/delivery-runs/${id}/depart`, staff)).json().error.code).toBe('courier_required');
    const upd = await call('PUT', `/delivery-runs/${id}`, staff, { orderIds: [a.id, c.id, b.id], optimize: false });
    expect(upd.json()).toMatchObject({ routeBy: 'google_manual' });
    let [run] = await active();
    expect(run.stops.map((s: any) => s.number)).toEqual([a.number, c.number, b.number]);
    // Tirar um pedido devolve ele para a lista.
    await call('PUT', `/delivery-runs/${id}`, staff, { orderIds: [a.id, b.id], optimize: false });
    expect((await call('GET', '/deliveries/available', staff)).json().orders.map((o: any) => o.id)).toEqual([c.id]);
    expect((await call('POST', `/delivery-runs/${id}/cancel`, staff)).statusCode).toBe(200);
    expect((await call('GET', '/deliveries/available', staff)).json().orders).toHaveLength(3);
    expect(await active()).toEqual([]);
  });

  it('sem Google: ordem pela distância e pedido cancelado fica de fora na saída', async () => {
    setTripPlanner(async () => { throw new Error('respondeu 403 PERMISSION_DENIED'); });
    const k = await courier();
    const a = await newOrder('Rua A');
    const b = await newOrder('Rua B');
    await pool.query('UPDATE orders SET delivery_distance_km = 5 WHERE id = $1', [a.id]);
    await pool.query('UPDATE orders SET delivery_distance_km = 2 WHERE id = $1', [b.id]);
    const r = (await call('POST', '/delivery-runs', staff, { courierId: k, orderIds: [a.id, b.id] })).json();
    expect(r).toMatchObject({ routeBy: 'distance', routeError: 'respondeu 403 PERMISSION_DENIED' });
    let [run] = await active();
    expect(run.stops.map((s: any) => s.number)).toEqual([b.number, a.number]);
    expect(run.totalDistanceM).toBeNull();
    expect(run.mapsUrl).toContain('google.com/maps/dir/');

    const mgr = await loginAs(app, 'gerente@t.local');
    expect((await call('POST', `/orders/${b.id}/status`, mgr, { status: 'cancelled', note: 'cliente desistiu' })).statusCode).toBe(200);
    expect((await call('POST', `/delivery-runs/${run.id}/depart`, staff)).json()).toEqual({ ok: true, updated: 1 });
    [run] = await active();
    expect(run.stops.find((s: any) => s.orderId === b.id)).toMatchObject({ outcome: 'not_delivered', outcomeNote: 'pedido cancelado antes da saída' });
    expect(run.mapsUrl).not.toContain('Rua+B');
  });

  it('recusa retirada, pedido concluído e mais de 10 paradas', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/public/orders', payload: orderBody(f, { fulfillment: 'pickup', address: null }) });
    const p = (await pool.query('SELECT id FROM orders WHERE public_token = $1', [res.json().token])).rows[0].id;
    expect((await call('POST', '/delivery-runs', staff, { orderIds: [p] })).json().error.code).toBe('not_delivery');
    const a = await newOrder('Rua A');
    await pool.query(`UPDATE orders SET status = 'completed' WHERE id = $1`, [a.id]);
    expect((await call('POST', '/delivery-runs', staff, { orderIds: [a.id] })).json().error.code).toBe('order_closed');
    const many = Array.from({ length: 11 }, () => crypto.randomUUID());
    expect((await call('POST', '/delivery-runs', staff, { orderIds: many })).statusCode).toBe(400);
  });
});

describe('ajudantes', () => {
  it('cidade do endereço da loja e link do mapa', () => {
    expect(cityOf('Av. Itororó, 681 - Cidade Nova I, Indaiatuba - SP, 13334-050')).toEqual({ city: 'Indaiatuba', state: 'SP' });
    expect(mapsUrl([])).toBeNull();
    const u = new URL(mapsUrl(['Rua 1, 10', 'Rua 2, 20', 'Rua 3, 30'])!);
    expect(u.searchParams.get('destination')).toBe('Rua 3, 30');
    expect(u.searchParams.get('waypoints')).toBe('Rua 1, 10|Rua 2, 20');
    expect(u.searchParams.get('travelmode')).toBe('driving');
  });
});
