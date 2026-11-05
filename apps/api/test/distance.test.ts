import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seed, makeApp, orderBody, loginAs, pool, type Fixture } from './helpers.js';
import { distanceKm, geocodeText, setGeocoder } from '../src/services/geocode.js';
import { setRouter } from '../src/services/routing.js';
import { setGoogle } from '../src/services/google.js';

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
afterEach(() => {
  setGeocoder(null);
  setRouter(null);
  setGoogle(null);
});
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

  it('bairro fora da lista com endereço achado é cadastrado com o valor da faixa; bairro desativado continua recusado', async () => {
    await pool.query('UPDATE store_settings SET accept_unlisted_neighborhoods = false'); // na taxa por km, salva mesmo assim
    const res = await post(orderBody(f, { address: addr('Rua Perto', { neighborhoodId: undefined, neighborhoodName: 'Jardim Qualquer' }) }));
    const o = (await pool.query('SELECT * FROM orders WHERE public_token = $1', [res.json().token])).rows[0];
    expect(o).toMatchObject({ delivery_fee_cents: 500, neighborhood_name: 'Jardim Qualquer' });
    const h = (await pool.query(`SELECT * FROM neighborhoods WHERE name = 'Jardim Qualquer'`)).rows[0];
    expect(h).toMatchObject({ id: o.neighborhood_id, fee_cents: 500, fee_pending: false });
    // Bairro "a combinar" ganha o valor; bairro com taxa definida pela loja não muda.
    await pool.query(`UPDATE neighborhoods SET fee_pending = true, fee_cents = 0 WHERE name = 'Jardim Qualquer'`);
    await post(orderBody(f, { address: addr('Rua Media', { neighborhoodId: undefined, neighborhoodName: 'Jardim Qualquer' }) }));
    expect((await pool.query(`SELECT fee_cents, fee_pending FROM neighborhoods WHERE name = 'Jardim Qualquer'`)).rows[0]).toEqual({ fee_cents: 800, fee_pending: false });
    await post(orderBody(f, { address: addr('Rua Media') }));
    expect((await pool.query('SELECT fee_cents FROM neighborhoods WHERE id = $1', [f.hoodAId])).rows[0].fee_cents).toBe(600);
    // A cotação não grava nada.
    await app.inject({ method: 'POST', url: '/api/public/quote', payload: { items: orderBody(f).items, neighborhoodName: 'Jardim Cotação', city: 'Indaiatuba', address: { street: 'Rua Perto', number: '1', city: 'Indaiatuba', state: 'SP', cep: '' } } });
    expect((await pool.query(`SELECT count(*)::int c FROM neighborhoods WHERE name = 'Jardim Cotação'`)).rows[0].c).toBe(0);
    expect((await post(orderBody(f, { address: addr('Rua Perto', { neighborhoodId: f.hoodOffId }) }))).json().error.code).toBe('area_not_served');
  });

  it('Google Maps: endereço com CEP, rota pelas ruas, guardada; com a chave, só o Google vale', async () => {
    const asked: string[] = [];
    setGoogle(async (_o, dest) => {
      asked.push(dest);
      if (dest.includes('Rua Do Google')) return { meters: 4873, start: null, end: { lat: -23.07, lng: -47.18 }, types: ['route'], partial: false };
      if (dest.includes('Cidade Inteira')) return { meters: 9000, start: null, end: null, types: ['locality', 'political'], partial: false };
      return null;
    });
    const q = (street: string) => app.inject({ method: 'POST', url: '/api/public/quote', payload: { items: orderBody(f).items, neighborhoodId: f.hoodAId, address: { street, number: '787', city: 'Indaiatuba', state: 'SP', cep: '13336030' } } });
    expect((await q('Rua Do Google')).json()).toMatchObject({ deliveryFeeCents: 800, deliveryDistanceKm: 4.87, deliveryDistanceBy: 'route' });
    expect(asked[0]).toBe('Rua Do Google, 787, Centro, Indaiatuba - SP, 13336-030, Brasil');
    await q('Rua Do Google');
    expect(asked).toHaveLength(1); // guardado
    // Google só acha a cidade (vago demais) ou fora do ar: pede para conferir o CEP, sem usar outro mapa nem a taxa do bairro.
    let r = (await q('Cidade Inteira Rua Perto')).json();
    expect(r.error).toMatchObject({ code: 'address_not_found', details: { field: 'address.cep' } });
    expect(r.error.message).toMatch(/Confira o CEP e o número/);
    setGoogle(async () => { throw new Error('respondeu 403 PERMISSION_DENIED'); });
    r = (await post(orderBody(f, { address: addr('Rua Perto') }))).json();
    expect(r.error.code).toBe('address_not_found');
  });

  it('valor por km: km × valor, taxa mínima e raio máximo; cliente sem escolher bairro', async () => {
    await pool.query(`UPDATE store_settings SET distance_pricing = 'per_km', price_per_km_cents = 200, distance_min_fee_cents = 500, distance_max_km = 8`);
    setGoogle(async (_o, dest) => ({ meters: dest.includes('Rua Media') ? 4873 : dest.includes('Rua Perto') ? 1000 : 9500, start: null, end: null, types: ['street_address'], partial: false }));
    // Só CEP (bairro vem do CEP, pode faltar): 4,87 km × R$ 2,00 = R$ 9,74.
    const q = (street: string, extra: object = {}) => app.inject({ method: 'POST', url: '/api/public/quote', payload: { items: orderBody(f).items, ...extra, address: { street, number: '10', city: 'Indaiatuba', state: 'SP', cep: '13336030' } } });
    expect((await q('Rua Media')).json()).toMatchObject({ deliveryFeeCents: 974, deliveryDistanceKm: 4.87 });
    expect((await q('Rua Perto', { neighborhoodName: 'Jardim do CEP' })).json()).toMatchObject({ deliveryFeeCents: 500 }); // mínimo
    expect((await q('Rua Longe')).json().error.message).toMatch(/9,5 km.*até 8,0 km/);
    const res = await post(orderBody(f, { address: addr('Rua Media', { neighborhoodId: undefined, neighborhoodName: '' }) }));
    expect(res.statusCode).toBe(201);
    const o = (await pool.query('SELECT * FROM orders WHERE public_token = $1', [res.json().token])).rows[0];
    expect(o).toMatchObject({ delivery_fee_cents: 974, delivery_fee_source: 'distance', neighborhood_id: null });
    // Painel salva e devolve a forma de cobrança.
    const h = await loginAs(app, 'gerente@t.local');
    const put = await app.inject({ method: 'PUT', url: '/api/admin/settings/distance', headers: h, payload: { mode: 'distance', storeLat: -23.1, storeLng: -47.2, tiers: [], pricing: 'per_km', pricePerKmCents: 250, minFeeCents: 600, maxKm: null } });
    expect(put.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/admin/settings', headers: h })).json().distance).toMatchObject({ pricing: 'per_km', pricePerKmCents: 250, minFeeCents: 600, maxKm: null });
    const bad = await app.inject({ method: 'PUT', url: '/api/admin/settings/distance', headers: h, payload: { mode: 'distance', storeLat: -23.1, storeLng: -47.2, tiers: [], pricing: 'per_km', pricePerKmCents: 0 } });
    expect(bad.statusCode).toBe(400);
  });

  it('taxa por bairro continua exigindo o bairro', async () => {
    await pool.query(`UPDATE store_settings SET delivery_fee_mode = 'neighborhood'`);
    const res = await post(orderBody(f, { address: addr('Rua Perto', { neighborhoodId: undefined }) }));
    expect(res.json().error).toMatchObject({ code: 'area_not_served', message: 'Selecione o bairro.' });
  });

  it('painel: preenche a taxa dos bairros "a combinar" pelo mapa, sem mexer nos definidos', async () => {
    const h = await loginAs(app, 'gerente@t.local');
    await pool.query(`INSERT INTO neighborhoods (store_id, name, city, fee_cents, fee_pending) VALUES ($1,'Jardim Perto','Indaiatuba',0,true), ($1,'Jardim Sumido','Indaiatuba',0,true)`, [f.storeId]);
    setGoogle(async (_o, dest) => (dest.startsWith('Jardim Perto') ? { meters: 1500, start: null, end: null, types: ['sublocality'], partial: false } : null));
    setGeocoder(async () => null);
    const r = (await app.inject({ method: 'POST', url: '/api/admin/neighborhoods/fill-fees', headers: h, payload: {} })).json();
    expect(r.updated).toEqual([{ name: 'Jardim Perto', km: 1.5, feeCents: 500 }]);
    expect(r.skipped).toEqual([{ name: 'Jardim Sumido', reason: 'não achei no mapa' }]);
    expect((await pool.query(`SELECT fee_cents, fee_pending FROM neighborhoods WHERE name = 'Jardim Perto'`)).rows[0]).toEqual({ fee_cents: 500, fee_pending: false });
    expect((await pool.query('SELECT fee_cents FROM neighborhoods WHERE id = $1', [f.hoodAId])).rows[0].fee_cents).toBe(600);
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
    expect(s.distance).toEqual({ mode: 'distance', storeLat: -23.1, storeLng: -47.2, tiers: [{ maxKm: 1.5, feeCents: 400 }, { maxKm: 3, feeCents: 600 }], pricing: 'tiers', pricePerKmCents: 0, minFeeCents: 0, maxKm: null });
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

  it('checkout com número: OpenStreetMap em 429 e Photon sem achar o número ainda calcula pela rua', async () => {
    setGeocoder(async (q) => {
      if (q.provider === 'nominatim') throw new Error('respondeu 429');
      if (q.provider === 'photon' && q.q === 'Rua Media, Indaiatuba SP') return { ...PLACES['Rua Media'], label: 'Rua Media' };
      return null; // com o número, o Photon não acha
    });
    expect((await quote('Rua Media')).json()).toMatchObject({ deliveryFeeCents: 800, deliveryFeePending: false });
  });

  it('último recurso: centro do bairro, inclusive bairro fora da lista', async () => {
    await pool.query('UPDATE store_settings SET accept_unlisted_neighborhoods = true');
    setGeocoder(async (q) => (q.provider === 'photon' && q.q === 'Jardim Novo, Indaiatuba SP' ? { ...PLACES['Rua Perto'], label: 'Jardim Novo' } : null));
    const r = await app.inject({ method: 'POST', url: '/api/public/quote', payload: { items: orderBody(f).items, neighborhoodName: 'Jardim Novo', city: 'Indaiatuba', address: { street: 'Rua Sem Mapa', number: '787', city: 'Indaiatuba', state: 'SP', cep: '' } } });
    expect(r.json()).toMatchObject({ deliveryFeeCents: 500, deliveryFeePending: false });
  });

  it('pelas ruas: cobra pela rota de carro, guarda a rota e grava como foi medido', async () => {
    let routes = 0;
    setRouter(async () => { routes++; return 1600; }); // 1,6 km pelas ruas (linha reta ~1,0 km)
    expect((await quote('Rua Perto')).json()).toMatchObject({ deliveryFeeCents: 500, deliveryDistanceKm: 1.6, deliveryDistanceBy: 'route' });
    setRouter(async () => { routes++; return 4200; });
    expect((await quote('Rua Perto')).json()).toMatchObject({ deliveryDistanceKm: 1.6 }); // rota guardada, não consulta de novo
    expect(routes).toBe(1);
    setRouter(async () => 2600); // 2,6 km: passa para a faixa de R$ 8
    const res = await post(orderBody(f, { address: addr('Rua Media') }));
    const o = (await pool.query('SELECT * FROM orders WHERE public_token = $1', [res.json().token])).rows[0];
    expect(o).toMatchObject({ delivery_fee_cents: 800, delivery_distance_by: 'route' });
    expect(Number(o.delivery_distance_km)).toBeCloseTo(2.6, 2);
  });

  it('serviço de rotas fora do ar ou sem rota: usa a linha reta', async () => {
    setRouter(async () => { throw new Error('respondeu 503'); });
    expect((await quote('Rua Perto')).json()).toMatchObject({ deliveryFeeCents: 500, deliveryDistanceBy: 'straight' });
    setRouter(async () => null);
    const r = (await quote('Rua Media')).json();
    expect(r).toMatchObject({ deliveryFeeCents: 800, deliveryDistanceBy: 'straight' });
    expect(r.deliveryDistanceKm).toBeCloseTo(3.0, 1);
  });

  it('pela rota, fora das faixas não entrega', async () => {
    setRouter(async () => 5400);
    const res = await post(orderBody(f, { address: addr('Rua Media') }));
    expect(res.json().error.message).toMatch(/5,4 km.*até 5,0 km/);
  });

  it('painel testa um endereço e mostra cada tentativa', async () => {
    const h = await loginAs(app, 'gerente@t.local');
    setGeocoder(async (q) => (q.provider === 'photon' && q.q.includes('Rua Perto') ? { ...PLACES['Rua Perto'], label: 'Rua Perto, Indaiatuba' } : null));
    const r = (await app.inject({ method: 'POST', url: '/api/admin/settings/test-address', headers: h, payload: { street: 'Rua Perto', number: '10', city: 'Indaiatuba', state: 'SP', cep: '' } })).json();
    expect(r).toMatchObject({ found: { provider: 'photon', label: 'Rua Perto, Indaiatuba' }, feeCents: 500, outOfArea: false });
    expect(r).toMatchObject({ distanceBy: 'straight', routingConfigured: false });
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
