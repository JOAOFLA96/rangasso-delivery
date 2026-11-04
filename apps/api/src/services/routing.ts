import type { Db } from '../db/pool.js';
import { config } from '../config.js';
import { distanceKm } from './geocode.js';

// Distância de carro pelas ruas (OpenRouteService, plano grátis: 2.000 rotas/dia, 40/min). Sem chave, com o serviço fora
// do ar ou no limite, vale a linha reta. Rotas ficam guardadas: o mesmo endereço não gasta cota de novo.

export interface Point { lat: number; lng: number }
export type RouteFn = (from: Point, to: Point) => Promise<number | null>; // metros
export interface Distance { km: number; by: 'route' | 'straight'; error?: string }

const ORS_URL = 'https://api.openrouteservice.org';
const GAP_MS = 1600; // 40 por minuto
const MAX_WAITING = 8;
const COOLDOWN_MS = 15 * 60_000;
const CACHE_DAYS = 90;

const q = { last: 0, queue: Promise.resolve() as Promise<unknown>, waiting: 0 };
let cooldownUntil = 0;

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  if (q.waiting >= MAX_WAITING) return Promise.reject(new Error('serviço de rotas ocupado'));
  q.waiting++;
  const run = q.queue.then(async () => {
    const wait = q.last + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    q.last = Date.now();
    return fn();
  });
  q.queue = run.catch(() => undefined);
  return run.finally(() => { q.waiting--; });
}

const ors: RouteFn = async (from, to) => {
  const key = config.ORS_API_KEY;
  if (!key) return null;
  if (cooldownUntil > Date.now()) throw new Error('pausado após limite de uso');
  const url = new URL('/v2/directions/driving-car', ORS_URL);
  url.searchParams.set('start', `${from.lng},${from.lat}`);
  url.searchParams.set('end', `${to.lng},${to.lat}`);
  return throttled(async () => {
    // A chave vai no cabeçalho (não na URL) para não aparecer em logs.
    const res = await fetch(url, { headers: { authorization: key, accept: 'application/geo+json' }, signal: AbortSignal.timeout(6000) });
    if (res.status === 429 || res.status === 403) cooldownUntil = Date.now() + COOLDOWN_MS;
    if (res.status === 404) return null; // sem rota (ponto longe de qualquer rua)
    if (!res.ok) throw new Error(`respondeu ${res.status}`);
    const data = (await res.json()) as { features?: { properties?: { summary?: { distance?: number } } }[] };
    const m = data.features?.[0]?.properties?.summary?.distance;
    return typeof m === 'number' && Number.isFinite(m) ? Math.round(m) : null;
  });
};

let routeFn: RouteFn = ors;
// Testes trocam o serviço de rotas por um falso.
export function setRouter(fn: RouteFn | null) {
  routeFn = fn ?? ors;
}
export const routingEnabled = () => routeFn !== ors || !!config.ORS_API_KEY;

const round2 = (n: number) => Math.round(n * 100) / 100;
// ~11 m de precisão: o mesmo endereço cai na mesma chave.
const keyOf = (a: Point, b: Point) => [a.lat, a.lng, b.lat, b.lng].map((n) => n.toFixed(4)).join(',');

// Distância da loja até o cliente: pela rua quando possível, senão em linha reta.
export async function deliveryDistance(db: Db, store: Point, customer: Point): Promise<Distance> {
  const straight = round2(distanceKm(store, customer));
  if (!routingEnabled()) return { km: straight, by: 'straight' };
  const key = keyOf(store, customer);
  const c = await db.query(`SELECT distance_m FROM route_cache WHERE route_key = $1 AND created_at > now() - make_interval(days => $2)`, [key, CACHE_DAYS]);
  if (c.rows[0]) return { km: round2(c.rows[0].distance_m / 1000), by: 'route' };
  try {
    const m = await routeFn(store, customer);
    if (m == null) return { km: straight, by: 'straight', error: 'sem rota' };
    await db.query(
      `INSERT INTO route_cache (route_key, distance_m) VALUES ($1,$2)
       ON CONFLICT (route_key) DO UPDATE SET distance_m = EXCLUDED.distance_m, created_at = now()`,
      [key, m],
    );
    return { km: round2(m / 1000), by: 'route' };
  } catch (e) {
    return { km: straight, by: 'straight', error: (e as Error).message };
  }
}

// Diagnóstico (/api/health/maps): a chave está configurada e o serviço responde?
export async function probeRouting() {
  if (!config.ORS_API_KEY) return { provider: 'openrouteservice', configured: false };
  const t = Date.now();
  try {
    const m = await ors({ lat: -23.0866, lng: -47.2186 }, { lat: -23.0905, lng: -47.2101 });
    return { provider: 'openrouteservice', configured: true, ok: true, found: m != null, ms: Date.now() - t };
  } catch (e) {
    return { provider: 'openrouteservice', configured: true, ok: false, ms: Date.now() - t, error: (e as Error).message };
  }
}
