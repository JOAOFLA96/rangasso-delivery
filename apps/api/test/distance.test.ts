import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seed, makeApp, orderBody, loginAs, pool, type Fixture } from './helpers.js';
import { distanceKm, geocodeText, setGeocoder } from '../src/services/geocode.js';

let app: Awaited<ReturnType<typeof makeApp>>;
let f: Fixture;
const STORE = { lat: -23.1, lng: -47.2 };
// Mapa falso: 1 grau de latitude ≈ 111,19 km.
const PLACES: Record<string, { lat: number; lng: number }> = {
  'Rua Perto': { lat: -23.091, lng: -47.2 }, // ~1,0 km
  'Rua Media': { lat: -23.073, lng: -47.2 }, // ~3,0 km
  'Rua Longe': { lat: -23.01, lng: -47.2 }, // ~10 km
};
let calls: Record<string, string>[] = [];

beforeEach(async () => {
  await resetDb();
  f = await seed();
  app ??= await makeApp();
  calls = [];
  setGeocoder(async (q) => {
    calls.push(q);
    const hit = Object.entries(PLACES).find(([name]) => (q.street ?? q.q ?? '').includes(name));
    return hit ? { ...hit[1], label: hit[0] } : null;
  });
  await pool.query(`UPDATE store_settings SET delivery_fee_mode = 'distance', store_lat = $1, store_lng = $2`, [STORE.lat, STORE.lng]);
  await pool.query(`INSERT INTO delivery_distance_tiers (store_id, max_km, fee_cents) VALUES ($1, 2, 500), ($1, 5, 800)`, [f.storeId]);
});
afterEach(() => setGeocoder(null));
afterAll(async () => {
  await app.close();
});

const addr = (street: string, extra: Record<string, unknown> = {}) => ({ cep: '13334-050', street, number: '10', city: 'Indaiatuba', state: 'SP', neighborhoodId: f.hoodAId, ...extra });
const post = (payload: any) => app.inject({ method: 'POST', url: '/api/public/orders', payload });
const quote = (street: string) =>
  app.inject({ method: 'POST', url: '/api/public/quote', payload: { items: orderBody(f).items, neighborhoodId: f.hoodAId, address: { street, number: '10', city: 'Indaiatuba', state: 'SP', cep: '' } } });

describe('taxa por km', () => {
  it('distância em linha reta', () => {
    expect(distanceKm(STORE, PLACES['Rua Media'])).toBeCloseTo(3.0, 1);
  });

  it('cobra a faixa da distância e grava no pedido', async () => {
    expect((await quote('Rua Perto')).json()).toMatchObject({ deliveryFeeCents: 500, totalCents: 7500 });
    expect((await quote('Rua Media')).json()).toMatchObject({ deliveryFeeCents: 800 });
    const res = await post(orderBody(f, { address: addr('Rua Media') }));
    expect(res.statusCode).toBe(201);
    const o = (await pool.query('SELECT * FROM orders WHERE public_token = $1', [res.json().token])).rows[0];
    expect(o).toMatchObject({ delivery_fee_cents: 800, delivery_fee_source: 'distance', neighborhood_name: 'Centro' });
    expect(Number(o.delivery_distance_km)).toBeCloseTo(3.0, 1);
    const pub = await app.inject({ method: 'GET', url: `/api/public/orders/${res.json().token}` });
    expect(pub.json().deliveryDistanceKm).toBeCloseTo(3.0, 1);
  });

  it('fora do raio não entrega e diz a distância', async () => {
    const res = await post(orderBody(f, { address: addr('Rua Longe') }));
    expect(res.json().error.code).toBe('area_not_served');
    expect(res.json().error.message).toMatch(/10,0 km.*até 5,0 km/);
  });

  it('endereço não encontrado ou mapa fora do ar: usa a taxa do bairro', async () => {
    let res = await post(orderBody(f, { address: addr('Rua Inexistente') }));
    let o = (await pool.query('SELECT * FROM orders WHERE public_token = $1', [res.json().token])).rows[0];
    expect(o).toMatchObject({ delivery_fee_cents: 600, delivery_fee_source: 'neighborhood', delivery_distance_km: null });
    setGeocoder(async () => { throw new Error('fora do ar'); });
    res = await post(orderBody(f, { address: addr('Rua Perto') }));
    o = (await pool.query('SELECT * FROM orders WHERE public_token = $1', [res.json().token])).rows[0];
    expect(o).toMatchObject({ delivery_fee_cents: 600, delivery_fee_source: 'neighborhood' });
  });

  it('bairro fora da lista com endereço achado não vira cadastro; bairro desativado continua recusado', async () => {
    const res = await post(orderBody(f, { address: addr('Rua Perto', { neighborhoodId: undefined, neighborhoodName: 'Jardim Qualquer' }) }));
    const o = (await pool.query('SELECT * FROM orders WHERE public_token = $1', [res.json().token])).rows[0];
    expect(o).toMatchObject({ delivery_fee_cents: 500, neighborhood_name: 'Jardim Qualquer', neighborhood_id: null });
    expect((await pool.query(`SELECT count(*)::int c FROM neighborhoods`)).rows[0].c).toBe(2);
    expect((await post(orderBody(f, { address: addr('Rua Perto', { neighborhoodId: f.hoodOffId }) }))).json().error.code).toBe('area_not_served');
  });

  it('guarda o resultado do mapa e não consulta de novo', async () => {
    await quote('Rua Perto');
    const n = calls.length;
    await quote('Rua Perto');
    expect(calls.length).toBe(n);
  });

  it('modo por bairro ignora a distância', async () => {
    await pool.query(`UPDATE store_settings SET delivery_fee_mode = 'neighborhood'`);
    expect((await quote('Rua Media')).json()).toMatchObject({ deliveryFeeCents: 600 });
    expect(calls.length).toBe(0);
  });

  it('painel: localizar a loja, salvar faixas e validar', async () => {
    const h = await loginAs(app, 'gerente@t.local');
    PLACES['Avenida Itororó, 681'] = STORE;
    const loc = await app.inject({ method: 'POST', url: '/api/admin/settings/locate-store', headers: h, payload: { address: 'Av. Itororó, 681 - Cidade Nova I, Indaiatuba - SP, 13334-050' } });
    expect(loc.json()).toMatchObject({ lat: STORE.lat, lng: STORE.lng });
    const bad = await app.inject({ method: 'PUT', url: '/api/admin/settings/distance', headers: h, payload: { mode: 'distance', storeLat: null, storeLng: null, tiers: [] } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'PUT', url: '/api/admin/settings/distance', headers: h, payload: { mode: 'distance', storeLat: -23.1, storeLng: -47.2, tiers: [{ maxKm: 3, feeCents: 600 }, { maxKm: 1.5, feeCents: 400 }] } });
    expect(ok.statusCode).toBe(200);
    const s = (await app.inject({ method: 'GET', url: '/api/admin/settings', headers: h })).json();
    expect(s.distance).toEqual({ mode: 'distance', storeLat: -23.1, storeLng: -47.2, tiers: [{ maxKm: 1.5, feeCents: 400 }, { maxKm: 3, feeCents: 600 }] });
    const staff = await loginAs(app, 'atendente@t.local');
    expect((await app.inject({ method: 'PUT', url: '/api/admin/settings/distance', headers: staff, payload: { mode: 'neighborhood', storeLat: null, storeLng: null, tiers: [] } })).statusCode).toBe(403);
  });

  it('endereço da loja numa linha: tenta sem o bairro', async () => {
    const tried: string[] = [];
    setGeocoder(async (q) => { tried.push(`${q.provider}: ${q.q ?? q.cep}`); return null; });
    expect(await geocodeText(pool, 'Av. Itororó, 681 - Cidade Nova I, Indaiatuba - SP, 13334-050')).toBeNull();
    expect(tried).toEqual([
      'nominatim: Avenida Itororó, 681 - Cidade Nova I, Indaiatuba - SP',
      'nominatim: Avenida Itororó, 681, Indaiatuba - SP',
      'photon: Avenida Itororó, 681, Indaiatuba SP',
      'cep: 13334050',
    ]);
  });

  it('se o mapa não acha a rua, usa a coordenada do CEP; um serviço fora do ar não impede os outros', async () => {
    setGeocoder(async (q) => {
      if (q.provider === 'nominatim') throw new Error('respondeu 403');
      if (q.provider === 'cep' && q.cep === '13334050') return { lat: -23.073, lng: -47.2, label: 'CEP' }; // ~3 km
      return null;
    });
    const res = await post(orderBody(f, { address: addr('Rua Desconhecida') }));
    const o = (await pool.query('SELECT * FROM orders WHERE public_token = $1', [res.json().token])).rows[0];
    expect(o).toMatchObject({ delivery_fee_cents: 800, delivery_fee_source: 'distance' });
  });

  it('painel testa um endereço e mostra cada tentativa', async () => {
    const h = await loginAs(app, 'gerente@t.local');
    setGeocoder(async (q) => (q.provider === 'photon' && q.q.includes('Rua Perto') ? { ...PLACES['Rua Perto'], label: 'Rua Perto, Indaiatuba' } : null));
    const r = (await app.inject({ method: 'POST', url: '/api/admin/settings/test-address', headers: h, payload: { street: 'Rua Perto', number: '10', city: 'Indaiatuba', state: 'SP', cep: '' } })).json();
    expect(r).toMatchObject({ found: { provider: 'photon', label: 'Rua Perto, Indaiatuba' }, feeCents: 500, outOfArea: false });
    expect(r.distanceKm).toBeCloseTo(1.0, 1);
    expect(r.trace.map((t: any) => `${t.provider} ${t.result}`)).toEqual(['nominatim não achou', 'nominatim não achou', 'photon achou']);
    const staff = await loginAs(app, 'atendente@t.local');
    expect((await app.inject({ method: 'POST', url: '/api/admin/settings/test-address', headers: staff, payload: { street: 'Rua Perto', city: 'Indaiatuba' } })).statusCode).toBe(403);
  });

  it('salvar a taxa por km guarda o endereço da loja', async () => {
    const h = await loginAs(app, 'gerente@t.local');
    const address = 'Av. Itororó, 681 - Cidade Nova I, Indaiatuba - SP, 13334-050';
    await app.inject({ method: 'PUT', url: '/api/admin/settings/distance', headers: h, payload: { mode: 'distance', storeLat: -23.1, storeLng: -47.2, tiers: [{ maxKm: 3, feeCents: 600 }], address } });
    expect((await app.inject({ method: 'GET', url: '/api/public/store' })).json().address).toBe(address);
  });
});
