import type { Db } from '../db/pool.js';
import { config } from '../config.js';
import { normalizeName, onlyDigits } from '../lib/text.js';

// Localização de endereços para a taxa por km. Usa o Nominatim (OpenStreetMap), gratuito, com as regras de uso dele:
// no máximo 1 consulta por segundo, identificação do sistema no User-Agent e cache dos resultados.
// https://operations.osmfoundation.org/policies/nominatim/

export interface GeoAddress { street: string; number: string; city: string; state: string; cep: string }
export interface GeoPoint { lat: number; lng: number; precision: 'number' | 'street' | 'cep'; label: string }
export type GeocodeFn = (q: Record<string, string>) => Promise<{ lat: number; lng: number; label: string } | null>;

const NEGATIVE_TTL_MS = 24 * 3600_000;
const MIN_GAP_MS = 1100;
let lastCall = 0;
let queue: Promise<unknown> = Promise.resolve();
let waiting = 0;
const MAX_WAITING = 8; // fila cheia (pico ou abuso): não espera, o pedido usa a taxa do bairro

async function nominatim(q: Record<string, string>) {
  const url = new URL('/search', config.GEOCODER_URL);
  for (const [k, v] of Object.entries({ ...q, format: 'jsonv2', limit: '1', countrycodes: 'br', 'accept-language': 'pt-BR' })) url.searchParams.set(k, v);
  // Fila: uma consulta por vez, com intervalo mínimo entre elas.
  if (waiting >= MAX_WAITING) throw new Error('serviço de mapas ocupado');
  waiting++;
  const run = queue.then(async () => {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const res = await fetch(url, {
      headers: { 'user-agent': `RangassoDelivery/1.0 (+${config.PUBLIC_URL})`, referer: config.PUBLIC_URL },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`serviço de mapas respondeu ${res.status}`);
    const list = (await res.json()) as { lat: string; lon: string; display_name: string }[];
    const r = list[0];
    return r ? { lat: Number(r.lat), lng: Number(r.lon), label: r.display_name ?? '' } : null;
  });
  queue = run.catch(() => undefined);
  return run.finally(() => { waiting--; });
}

let geocodeFn: GeocodeFn = nominatim;
// Testes trocam o serviço de mapas por um falso.
export function setGeocoder(fn: GeocodeFn | null) {
  geocodeFn = fn ?? nominatim;
}

async function cached(db: Db, key: string, q: Record<string, string>) {
  const c = await db.query('SELECT lat, lng, label, created_at FROM geocode_cache WHERE query_key = $1', [key]);
  const row = c.rows[0];
  if (row && (row.lat != null || Date.now() - new Date(row.created_at).getTime() < NEGATIVE_TTL_MS)) {
    return row.lat == null ? null : { lat: row.lat as number, lng: row.lng as number, label: row.label as string };
  }
  const r = await geocodeFn(q);
  await db.query(
    `INSERT INTO geocode_cache (query_key, lat, lng, label) VALUES ($1,$2,$3,$4)
     ON CONFLICT (query_key) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, label = EXCLUDED.label, created_at = now()`,
    [key, r?.lat ?? null, r?.lng ?? null, r?.label ?? ''],
  );
  return r;
}

// Tenta o endereço com número; depois só a rua; por último só o CEP. Devolve null se não achar (ou se o serviço falhar).
export async function geocodeAddress(db: Db, a: GeoAddress): Promise<GeoPoint | null> {
  const street = expandStreet(a.street.trim());
  const city = a.city.trim();
  const state = a.state.trim();
  const cep = onlyDigits(a.cep);
  const number = a.number.trim().match(/^\d+/)?.[0] ?? '';
  const attempts: { precision: GeoPoint['precision']; q: Record<string, string> }[] = [];
  const place = { ...(city ? { city } : {}), ...(state ? { state } : {}), country: 'Brasil' };
  if (street && city && number) attempts.push({ precision: 'number', q: { street: `${number} ${street}`, ...place } });
  if (street && city) attempts.push({ precision: 'street', q: { street, ...place } });
  if (cep.length === 8) attempts.push({ precision: 'cep', q: { postalcode: `${cep.slice(0, 5)}-${cep.slice(5)}`, country: 'Brasil' } });
  try {
    for (const t of attempts) {
      const key = normalizeName(JSON.stringify(t.q));
      const r = await cached(db, key, t.q);
      if (r) return { ...r, precision: t.precision };
    }
  } catch {
    return null; // fora do ar ou lento: o pedido segue pela taxa do bairro
  }
  return null;
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
export async function geocodeText(db: Db, text: string): Promise<GeoPoint | null> {
  const cep = text.match(/\b(\d{5})-?(\d{3})\b/);
  const clean = expandStreet(text.replace(/\b\d{5}-?\d{3}\b/, '')).replace(/[\s,-]+$/, '').trim();
  const parts = clean.split(/\s+-\s+/).map((p) => p.trim());
  const attempts: { precision: GeoPoint['precision']; q: Record<string, string> }[] = [];
  if (clean) attempts.push({ precision: 'number', q: { q: clean } });
  if (parts.length >= 3) {
    // parts = ["Avenida Itororó, 681", "Cidade Nova I, Indaiatuba", "SP"]: tira o bairro (antes da vírgula do meio).
    const middle = parts.slice(1, -1).join(', ');
    const city = middle.includes(',') ? middle.slice(middle.lastIndexOf(',') + 1).trim() : middle;
    attempts.push({ precision: 'number', q: { q: `${parts[0]}, ${city} - ${parts[parts.length - 1]}` } });
  }
  if (cep) attempts.push({ precision: 'cep', q: { postalcode: `${cep[1]}-${cep[2]}`, country: 'Brasil' } });
  try {
    for (const a of attempts) {
      const r = await cached(db, normalizeName(JSON.stringify(a.q)), a.q);
      if (r) return { ...r, precision: a.precision };
    }
  } catch {
    return null;
  }
  return null;
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
