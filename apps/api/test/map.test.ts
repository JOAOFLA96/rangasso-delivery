import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetDb, seed, makeApp, loginAs } from './helpers.js';
import { config } from '../src/config.js';

let app: Awaited<ReturnType<typeof makeApp>>;
let owner: Record<string, string>;

beforeAll(async () => {
  await resetDb();
  await seed();
  app = await makeApp();
  owner = await loginAs(app, 'dono@t.local');
});
afterEach(() => {
  (config as any).GOOGLE_MAPS_BROWSER_KEY = '';
  (config as any).GOOGLE_MAPS_API_KEY = '';
});
afterAll(async () => {
  await app.close();
});

const get = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/api/admin/map', headers });

describe('fundo do mapa do painel', () => {
  it('sem a chave do mapa usa o OpenStreetMap, mesmo havendo a chave da taxa de entrega', async () => {
    (config as any).GOOGLE_MAPS_API_KEY = 'chave-da-taxa';
    const r = (await get(owner)).json();
    expect(r).toEqual({ provider: 'osm' });
    expect(JSON.stringify(r)).not.toContain('chave-da-taxa');
  });

  it('com a chave do mapa manda só ela, e só para quem está logado', async () => {
    (config as any).GOOGLE_MAPS_API_KEY = 'chave-da-taxa';
    (config as any).GOOGLE_MAPS_BROWSER_KEY = 'chave-do-mapa';
    expect((await get(owner)).json()).toEqual({ provider: 'google', key: 'chave-do-mapa' });
    expect((await get({})).statusCode).toBe(401);
  });
});
