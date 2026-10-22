import type { Db } from '../db/pool.js';
import { config } from '../config.js';
import { normalizeName, onlyDigits } from '../lib/text.js';

// Localização de endereços para a taxa por km, com serviços gratuitos tentados em sequência (Nominatim e Photon, do
// OpenStreetMap, e a coordenada do CEP pela AwesomeAPI). Respeita os limites de uso com fila e cache dos resultados.

export interface GeoAddress { street: string; number: string; city: string; state: string; cep: string }
export interface GeoPoint { lat: number; lng: number; precision: 'number' | 'street' | 'cep'; label: string; provider: Provider }
export type Provider = 'nominatim' | 'photon' | 'cep';
// q traz o serviço em q.provider; o resto são os parâmetros da busca.
export type GeocodeFn = (q: Record<string, string>) => Promise<{ lat: number; lng: number; label: string } | null>;
// Registro de cada tentativa, mostrado no teste de endereço do painel.
export interface GeoTry { provider: Provider; query: string; result: 'achou' | 'não achou' | 'erro'; detail?: string; cached?: boolean }

const NEGATIVE_TTL_MS = 6 * 3600_000;
const MAX_WAITING = 8; // fila cheia (pico ou abuso): não espera, o pedido usa a taxa do bairro
const PHOTON_URL = 'https://photon.komoot.io';
const CEP_URL = 'https://cep.awesomeapi.com.br';

// Uma fila por serviço: uma consulta por vez, com intervalo mínimo entre elas.
const queues: Record<Provider, { last: number; queue: Promise<unknown>; waiting: number; gap: number }> = {
  nominatim: { last: 0, queue: Promise.resolve(), waiting: 0, gap: 1100 },
  photon: { last: 0, queue: Promise.resolve(), waiting: 0, gap: 300 },
  cep: { last: 0, queue: Promise.resolve(), waiting: 0, gap: 300 },
};

function throttled<T>(provider: Provider, fn: () => Promise<T>): Promise<T> {
  const st = queues[provider];
  if (st.waiting >= MAX_WAITING) return Promise.reject(new Error('serviço de mapas ocupado'));
  st.waiting++;
  const run = st.queue.then(async () => {
    const wait = st.last + st.gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    st.last = Date.now();
    return fn();
  });
  st.queue = run.catch(() => undefined);
  return run.finally(() => { st.waiting--; });
}

async function getJson(url: URL) {
  const res = await fetch(url, {
    headers: { 'user-agent': `RangassoDelivery/1.0 (+${config.PUBLIC_URL})`, referer: config.PUBLIC_URL, accept: 'application/json' },
    signal: AbortSignal.timeout(6000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`respondeu ${res.status}`);
  return res.json() as Promise<any>;
}

// Nominatim (OpenStreetMap): no máximo 1 consulta por segundo e identificação no User-Agent.
// https://operations.osmfoundation.org/policies/nominatim/
async function nominatim(q: Record<string, string>) {
  const url = new URL('/search', config.GEOCODER_URL);
  for (const [k, v] of Object.entries({ ...q, format: 'jsonv2', limit: '1', countrycodes: 'br', 'accept-language': 'pt-BR' })) url.searchParams.set(k, v);
  const list = ((await getJson(url)) ?? []) as { lat: string; lon: string; display_name: string }[];
  const r = list[0];
  return r ? { lat: Number(r.lat), lng: Number(r.lon), label: r.display_name ?? '' } : null;
}

// Photon (também usa os dados do OpenStreetMap, mas acha melhor endereço escrito de qualquer jeito).
// Só aceita resultado no Brasil e na cidade pedida, para não cair numa rua de mesmo nome em outra cidade.
async function photon(q: Record<string, string>) {
  const url = new URL('/api/', PHOTON_URL);
  url.searchParams.set('q', q.q);
  url.searchParams.set('limit', '5');
  const data = (await getJson(url)) as { features?: { geometry: { coordinates: [number, number] }; properties: Record<string, string> }[] } | null;
  const city = normalizeName(q.city ?? '');
  const hit = (data?.features ?? []).find((f) => {
    const p = f.properties ?? {};
    if (p.countrycode && p.countrycode.toUpperCase() !== 'BR') return false;
    return !city || [p.city, p.county, p.district, p.locality].some((c) => c && normalizeName(c) === city);
  });
  if (!hit) return null;
  const p = hit.properties;
  const label = [p.street ?? p.name, p.housenumber, p.district, p.city, p.state].filter(Boolean).join(', ');
  return { lat: hit.geometry.coordinates[1], lng: hit.geometry.coordinates[0], label };
}

// AwesomeAPI CEP: devolve a coordenada do CEP (no Brasil, quase sempre um trecho de rua).
async function cepApi(q: Record<string, string>) {
  const data = (await getJson(new URL(`/json/${q.cep}`, CEP_URL))) as { lat?: string; lng?: string; address?: string; district?: string; city?: string; state?: string } | null;
  const lat = Number(data?.lat);
  const lng = Number(data?.lng);
  if (!data || !Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  return { lat, lng, label: [data.address, data.district, data.city, data.state].filter(Boolean).join(', ') };
}

const live: GeocodeFn = ({ provider, ...q }) =>
  throttled(provider as Provider, () => (provider === 'photon' ? photon(q) : provider === 'cep' ? cepApi(q) : nominatim(q)));

let geocodeFn: GeocodeFn = live;
// Testes trocam o serviço de mapas por um falso.
export function setGeocoder(fn: GeocodeFn | null) {
  geocodeFn = fn ?? live;
}

interface Attempt { precision: GeoPoint['precision']; q: Record<string, string> }

async function cached(db: Db, a: Attempt, trace?: GeoTry[]) {
  const key = normalizeName(JSON.stringify(a.q));
  const provider = a.q.provider as Provider;
  const query = Object.entries(a.q).filter(([k]) => k !== 'provider').map(([, v]) => v).join(' | ');
  const c = await db.query('SELECT lat, lng, label, created_at FROM geocode_cache WHERE query_key = $1', [key]);
  const row = c.rows[0];
  if (row && (row.lat != null || Date.now() - new Date(row.created_at).getTime() < NEGATIVE_TTL_MS)) {
    trace?.push({ provider, query, result: row.lat == null ? 'não achou' : 'achou', cached: true, detail: row.label || undefined });
    return row.lat == null ? null : { lat: row.lat as number, lng: row.lng as number, label: row.label as string };
  }
  let r;
  try {
    r = await geocodeFn(a.q);
  } catch (e) {
    trace?.push({ provider, query, result: 'erro', detail: (e as Error).message });
    return null; // serviço fora do ar ou lento: tenta o próximo
  }
  trace?.push({ provider, query, result: r ? 'achou' : 'não achou', detail: r?.label || undefined });
  await db.query(
    `INSERT INTO geocode_cache (query_key, lat, lng, label) VALUES ($1,$2,$3,$4)
     ON CONFLICT (query_key) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, label = EXCLUDED.label, created_at = now()`,
    [key, r?.lat ?? null, r?.lng ?? null, r?.label ?? ''],
  );
  return r;
}

async function firstHit(db: Db, attempts: Attempt[], trace?: GeoTry[]): Promise<GeoPoint | null> {
  for (const a of attempts) {
    const r = await cached(db, a, trace);
    if (r) return { ...r, precision: a.precision, provider: a.q.provider as Provider };
  }
  return null;
}

// Tenta, nesta ordem: rua e número; só a rua; o endereço escrito (Photon); a coordenada do CEP.
// Devolve null se nenhum achar (ou se os serviços falharem): o pedido segue pela taxa do bairro.
export async function geocodeAddress(db: Db, a: GeoAddress, trace?: GeoTry[]): Promise<GeoPoint | null> {
  const street = expandStreet(a.street.trim());
  const city = a.city.trim();
  const state = a.state.trim();
  const cep = onlyDigits(a.cep);
  const number = a.number.trim().match(/^\d+/)?.[0] ?? '';
  const attempts: Attempt[] = [];
  const place = { ...(city ? { city } : {}), ...(state ? { state } : {}), country: 'Brasil' };
  if (street && city && number) attempts.push({ precision: 'number', q: { provider: 'nominatim', street: `${number} ${street}`, ...place } });
  if (street && city) attempts.push({ precision: 'street', q: { provider: 'nominatim', street, ...place } });
  if (street && city) attempts.push({ precision: number ? 'number' : 'street', q: { provider: 'photon', q: `${street}${number ? ` ${number}` : ''}, ${city}${state ? ` ${state}` : ''}`, city } });
  if (cep.length === 8) attempts.push({ precision: 'cep', q: { provider: 'cep', cep } });
  return firstHit(db, attempts, trace);
}

// Abreviações comuns que o mapa nem sempre entende.
export function expandStreet(s: string) {
  return s
    .replace(/\bAv\.?\s+/gi, 'Avenida ')
    .replace(/\bR\.\s*/g, 'Rua ')
    .replace(/\bAl\.\s*/gi, 'Alameda ')
    .replace(/\bTrav?\.\s*/gi, 'Travessa ')
    .replace(/\bEstr\.\s*/gi, 'Estrada ')
    .replace(/\bPça\.?\s+/gi, 'Praça ');
}

// Endereço da loja escrito numa linha (ex.: "Av. Itororó, 681 - Cidade Nova I, Indaiatuba - SP, 13334-050").
// Tenta: o texto inteiro; "rua, número, cidade - UF" (sem o bairro); só o CEP.
export async function geocodeText(db: Db, text: string, trace?: GeoTry[]): Promise<GeoPoint | null> {
  const cep = text.match(/\b(\d{5})-?(\d{3})\b/);
  const clean = expandStreet(text.replace(/\b\d{5}-?\d{3}\b/, '')).replace(/[\s,-]+$/, '').trim();
  const parts = clean.split(/\s+-\s+/).map((p) => p.trim());
  const attempts: Attempt[] = [];
  if (clean) attempts.push({ precision: 'number', q: { provider: 'nominatim', q: clean } });
  let short = '';
  let city = '';
  if (parts.length >= 3) {
    // parts = ["Avenida Itororó, 681", "Cidade Nova I, Indaiatuba", "SP"]: tira o bairro (antes da vírgula do meio).
    const middle = parts.slice(1, -1).join(', ');
    city = middle.includes(',') ? middle.slice(middle.lastIndexOf(',') + 1).trim() : middle;
    short = `${parts[0]}, ${city} - ${parts[parts.length - 1]}`;
    attempts.push({ precision: 'number', q: { provider: 'nominatim', q: short } });
  }
  if (clean) attempts.push({ precision: 'number', q: { provider: 'photon', q: (short || clean).replace(/\s+-\s+/g, ' '), city } });
  if (cep) attempts.push({ precision: 'cep', q: { provider: 'cep', cep: `${cep[1]}${cep[2]}` } });
  return firstHit(db, attempts, trace);
}

// Distância em linha reta (fórmula de haversine), em km.
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
