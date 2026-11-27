import { config } from '../config.js';

// Fundo do mapa do painel pelo Google (Map Tiles API, mapa 2D). O servidor busca cada pedaço do mapa e repassa ao navegador,
// assim a chave do Google nunca vai para a página. Se o Google recusar (API não ativada, limite, sem chave), o painel usa o
// OpenStreetMap como reserva.

const BASE = 'https://tile.googleapis.com/v1';
const COOLDOWN_MS = 10 * 60_000;

let session: { id: string; expiresAt: number } | null = null;
let creating: Promise<string> | null = null;
let cooldownUntil = 0;
let lastError = '';

export class TilesUnavailable extends Error {}

export const tilesStatus = () => ({ configured: !!config.GOOGLE_MAPS_API_KEY, pausedUntil: cooldownUntil > Date.now() ? cooldownUntil : null, lastError: lastError || null });

function fail(msg: string, pause: boolean): never {
  lastError = msg;
  if (pause) cooldownUntil = Date.now() + COOLDOWN_MS;
  throw new TilesUnavailable(msg);
}

async function getSession(key: string): Promise<string> {
  if (session && session.expiresAt > Date.now() + 60 * 60_000) return session.id;
  creating ??= (async () => {
    const res = await fetch(`${BASE}/createSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ mapType: 'roadmap', language: 'pt-BR', region: 'BR', scale: 'scaleFactor2x', highDpi: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { status?: string } } | null;
      fail(`Google recusou o mapa (${res.status}${body?.error?.status ? ` ${body.error.status}` : ''})`, true);
    }
    const data = (await res.json()) as { session?: string; expiry?: string };
    if (!data.session) fail('Google não devolveu a sessão do mapa', true);
    // expiry vem em segundos (texto); sem ele, renova em 1 dia.
    const exp = Number(data.expiry) * 1000;
    session = { id: data.session, expiresAt: Number.isFinite(exp) && exp > Date.now() ? exp : Date.now() + 24 * 3600_000 };
    lastError = '';
    return session.id;
  })().finally(() => { creating = null; });
  return creating;
}

export async function googleTile(z: number, x: number, y: number): Promise<{ body: Buffer; type: string; cache: string }> {
  const key = config.GOOGLE_MAPS_API_KEY;
  if (!key) throw new TilesUnavailable('sem chave do Google');
  if (cooldownUntil > Date.now()) throw new TilesUnavailable(`pausado: ${lastError}`);
  const id = await getSession(key);
  const res = await fetch(`${BASE}/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(id)}`, {
    headers: { 'x-goog-api-key': key },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) throw new TilesUnavailable('fora do mapa');
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) session = null; // sessão vencida: cria outra no próximo
    fail(`Google recusou o pedaço do mapa (${res.status})`, res.status === 403 || res.status === 429);
  }
  return {
    body: Buffer.from(await res.arrayBuffer()),
    type: res.headers.get('content-type') ?? 'image/png',
    cache: 'private, max-age=86400', // só no navegador de quem abriu; o servidor não guarda nada
  };
}
