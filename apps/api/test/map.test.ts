import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb, seed, makeApp, loginAs } from './helpers.js';
import { config } from '../src/config.js';

let app: Awaited<ReturnType<typeof makeApp>>;
let owner: Record<string, string>;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  await resetDb();
  await seed();
  app = await makeApp();
  owner = await loginAs(app, 'dono@t.local');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  (config as any).GOOGLE_MAPS_API_KEY = '';
});
afterAll(async () => {
  await app.close();
});

const get = (url: string, headers: Record<string, string> = owner) => app.inject({ method: 'GET', url: `/api/admin${url}`, headers });

describe('fundo do mapa do painel', () => {
  it('sem chave do Google: painel usa o OpenStreetMap e o pedaço responde 503', async () => {
    expect((await get('/map')).json().provider).toBe('osm');
    expect((await get('/map/tiles/13/3040/4630')).statusCode).toBe(503);
  });

  it('precisa estar logado e recusa pedaço inválido', async () => {
    expect((await get('/map/tiles/13/1/1', {})).statusCode).toBe(401);
    expect((await get('/map/tiles/2/9/0')).statusCode).toBe(400);
    expect((await get('/map/tiles/abc/1/1')).statusCode).toBe(400);
  });

  it('com chave: repassa a imagem do Google sem mandar a chave na URL; erro 403 pausa e volta ao OpenStreetMap', async () => {
    (config as any).GOOGLE_MAPS_API_KEY = 'chave-teste';
    const calls: { url: string; key: string | null }[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), key: new Headers(init?.headers).get('x-goog-api-key') });
      if (String(url).endsWith('/createSession')) return new Response(JSON.stringify({ session: 'S1', expiry: String(Math.floor(Date.now() / 1000) + 86400 * 14) }), { status: 200 });
      return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } });
    }) as any;
    expect((await get('/map')).json().provider).toBe('google');
    const t = await get('/map/tiles/13/3040/4630');
    expect(t.statusCode).toBe(200);
    expect(t.headers['content-type']).toBe('image/png');
    expect(t.rawPayload.length).toBe(4);
    await get('/map/tiles/13/3041/4630');
    expect(calls.filter((c) => c.url.endsWith('/createSession'))).toHaveLength(1); // sessão reaproveitada
    expect(calls.every((c) => c.key === 'chave-teste' && !c.url.includes('chave-teste'))).toBe(true);
    expect(calls[1].url).toContain('/2dtiles/13/3040/4630?session=S1');

    globalThis.fetch = vi.fn(async () => new Response('{"error":{"status":"PERMISSION_DENIED"}}', { status: 403 })) as any;
    expect((await get('/map/tiles/13/3042/4630')).statusCode).toBe(503);
    expect((await get('/map')).json().provider).toBe('osm');
  });
});
