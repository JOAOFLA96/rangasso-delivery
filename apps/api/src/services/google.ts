import type { Db } from '../db/pool.js';
import { config } from '../config.js';
import { normalizeName, onlyDigits } from '../lib/text.js';
import type { GeoAddress, GeoTry } from './geocode.js';

// Google Maps (Routes API): mede a distância de carro da loja até o endereço do cliente, escrito por extenso. O próprio Google
// acha o endereço, então não usa a Geocoding API (que exige faturamento ativado). Sem chave, fora do ar ou no limite, o sistema
// segue com os serviços gratuitos (OpenStreetMap, Photon, CEP) e o OpenRouteService ou a linha reta.

export interface Point { lat: number; lng: number }
export interface GoogleRoute { meters: number; start: Point | null; end: Point | null; types: string[]; partial: boolean }
export type GoogleFn = (origin: Point | string, destination: string) => Promise<GoogleRoute | null>;
export interface GoogleDistance { km: number; point: Point | null; precision: 'number' | 'street' | 'cep' | 'bairro'; cached?: boolean }

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const GAP_MS = 100;
const MAX_WAITING = 8;
const COOLDOWN_MS = 15 * 60_000;
const CACHE_DAYS = 90;

const q = { last: 0, queue: Promise.resolve() as Promise<unknown>, waiting: 0 };
let cooldownUntil = 0;
let lastError = '';

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  if (q.waiting >= MAX_WAITING) return Promise.reject(new Error('serviço do Google ocupado'));
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

const waypoint = (p: Point | string) => (typeof p === 'string' ? { address: p } : { location: { latLng: { latitude: p.lat, longitude: p.lng } } });
const toPoint = (l?: { latLng?: { latitude?: number; longitude?: number } }) =>
  l?.latLng?.latitude != null && l.latLng.longitude != null ? { lat: l.latLng.latitude, lng: l.latLng.longitude } : null;

const routes: GoogleFn = async (origin, destination) => {
  const key = config.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  if (cooldownUntil > Date.now()) throw new Error(`pausado após erro: ${lastError}`);
  return throttled(async () => {
    const res = await fetch(ROUTES_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': key, // no cabeçalho, para a chave não aparecer em logs de URL
        'x-goog-fieldmask': 'routes.distanceMeters,routes.legs.startLocation,routes.legs.endLocation,geocodingResults',
      },
      body: JSON.stringify({
        origin: waypoint(origin), destination: { address: destination }, travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE',
        languageCode: 'pt-BR', regionCode: 'BR', computeAlternativeRoutes: true, // fica com a mais curta: é o caminho do motoboy
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { status?: string; message?: string } } | null;
      // Endereço que o Google não acha vem como 400/404: é "não achou", não falha do serviço.
      if (res.status === 400 || res.status === 404) return null;
      lastError = `respondeu ${res.status}${body?.error?.status ? ` ${body.error.status}` : ''}`;
      if (res.status === 403 || res.status === 429) cooldownUntil = Date.now() + COOLDOWN_MS;
      throw new Error(lastError);
    }
    const data = (await res.json()) as {
      routes?: { distanceMeters?: number; legs?: { startLocation?: any; endLocation?: any }[] }[];
      geocodingResults?: { destination?: { type?: string[]; partialMatch?: boolean } };
    };
    // Rota de um ponto até ele mesmo vem sem distanceMeters (zero).
    const r = [...(data.routes ?? [])].sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0))[0];
    if (!r) return null;
    const g = data.geocodingResults?.destination;
    return { meters: r.distanceMeters ?? 0, start: toPoint(r.legs?.[0]?.startLocation), end: toPoint(r.legs?.[0]?.endLocation), types: g?.type ?? [], partial: !!g?.partialMatch };
  });
};

let googleFn: GoogleFn = routes;
// Testes trocam o Google por um falso.
export function setGoogle(fn: GoogleFn | null) {
  googleFn = fn ?? routes;
}
export const googleEnabled = () => googleFn !== routes || !!config.GOOGLE_MAPS_API_KEY;

// O que o Google achou define a precisão; cidade inteira (ou estado) é vago demais para cobrar por km.
function precisionOf(types: string[]): GoogleDistance['precision'] | null {
  const t = new Set(types);
  if (['street_address', 'premise', 'subpremise', 'establishment', 'point_of_interest'].some((x) => t.has(x))) return 'number';
  if (t.has('route') || t.has('intersection')) return 'street';
  if (t.has('postal_code')) return 'cep';
  if (['neighborhood', 'sublocality', 'sublocality_level_1'].some((x) => t.has(x))) return 'bairro';
  if (!types.length) return 'street'; // origem/destino por coordenada não traz tipo
  return null;
}

// Endereço numa linha, com o CEP: sem o CEP o Google às vezes escolhe uma rua parecida em outro bairro.
export function addressLine(a: GeoAddress) {
  const cep = onlyDigits(a.cep);
  const parts = [
    [a.street.trim(), a.number.trim()].filter(Boolean).join(', '),
    a.neighborhood?.trim(),
    [a.city.trim(), a.state.trim()].filter(Boolean).join(' - '),
    cep.length === 8 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : '',
    'Brasil',
  ];
  return parts.filter(Boolean).join(', ');
}

const keyOf = (store: Point, text: string) => `google|${store.lat.toFixed(4)},${store.lng.toFixed(4)}|${normalizeName(text)}`;

// Distância de carro da loja até o endereço. Devolve null se não houver chave, se o Google não achar o endereço com
// precisão suficiente ou se falhar (o motivo vai no trace).
export async function googleDistance(db: Db, store: Point, text: string, trace?: GeoTry[]): Promise<GoogleDistance | null> {
  if (!googleEnabled()) return null;
  const key = keyOf(store, text);
  const c = await db.query(`SELECT distance_m FROM route_cache WHERE route_key = $1 AND created_at > now() - make_interval(days => $2)`, [key, CACHE_DAYS]);
  if (c.rows[0]) {
    trace?.push({ provider: 'google', query: text, result: 'achou', cached: true });
    return { km: Math.round(c.rows[0].distance_m / 10) / 100, point: null, precision: 'street', cached: true };
  }
  let r: GoogleRoute | null;
  try {
    r = await googleFn(store, text);
  } catch (e) {
    trace?.push({ provider: 'google', query: text, result: 'erro', detail: (e as Error).message });
    return null;
  }
  const precision = r ? precisionOf(r.types) : null;
  if (!r || !precision) {
    trace?.push({ provider: 'google', query: text, result: 'não achou', detail: r ? `só achou: ${r.types.join(', ')}` : undefined });
    return null;
  }
  trace?.push({ provider: 'google', query: text, result: 'achou', detail: r.partial ? 'parecido (confira o endereço)' : undefined });
  await db.query(
    `INSERT INTO route_cache (route_key, distance_m) VALUES ($1,$2)
     ON CONFLICT (route_key) DO UPDATE SET distance_m = EXCLUDED.distance_m, created_at = now()`,
    [key, r.meters],
  );
  return { km: Math.round(r.meters / 10) / 100, point: r.end, precision };
}

// Ponto de um endereço escrito (usado para localizar a loja): rota do endereço até ele mesmo, lendo o ponto de partida.
export async function googleLocate(text: string): Promise<(Point & { precision: GoogleDistance['precision'] }) | null> {
  if (!googleEnabled()) return null;
  const r = await googleFn(text, text);
  const precision = r ? precisionOf(r.types) : null;
  return r?.start && precision ? { ...r.start, precision } : null;
}

// Diagnóstico (/api/health/maps).
export async function probeGoogle() {
  if (!config.GOOGLE_MAPS_API_KEY) return { provider: 'google', configured: false };
  const t = Date.now();
  try {
    const r = await routes({ lat: -23.0857, lng: -47.2072 }, 'Avenida Presidente Kennedy, 1000, Indaiatuba - SP, Brasil');
    return { provider: 'google', configured: true, ok: true, found: !!r, ms: Date.now() - t };
  } catch (e) {
    return { provider: 'google', configured: true, ok: false, ms: Date.now() - t, error: (e as Error).message };
  }
}
