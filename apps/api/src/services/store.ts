import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { notFound } from '../lib/errors.js';
import { computeOpenState, type OpenMode, type Shift } from './storeHours.js';

let cachedStoreId: string | null = null;

// O sistema atende uma loja por instalação (STORE_SLUG), mas todo dado já é vinculado a store_id.
export async function currentStoreId(): Promise<string> {
  if (cachedStoreId) return cachedStoreId;
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM stores WHERE slug = $1', [config.STORE_SLUG]);
  if (!rows[0]) throw notFound(`Loja "${config.STORE_SLUG}"`);
  cachedStoreId = rows[0].id;
  return cachedStoreId;
}

export function resetStoreCache() {
  cachedStoreId = null;
}

export async function getSettings(db: Db, storeId: string) {
  const { rows } = await db.query('SELECT * FROM store_settings WHERE store_id = $1', [storeId]);
  if (!rows[0]) throw notFound('Configuração da loja');
  return rows[0];
}

export async function getOpenState(db: Db, storeId: string, settings?: any, now = new Date()) {
  const s = settings ?? (await getSettings(db, storeId));
  const hours = await db.query<Shift>(
    `SELECT weekday, to_char(opens_at,'HH24:MI') AS opens_at, to_char(closes_at,'HH24:MI') AS closes_at
       FROM opening_hours WHERE store_id = $1`,
    [storeId],
  );
  const closures = await db.query<{ date: string }>(
    `SELECT to_char(date,'YYYY-MM-DD') AS date FROM store_closures
      WHERE store_id = $1 AND date BETWEEN current_date - 2 AND current_date + 10`,
    [storeId],
  );
  return computeOpenState(now, s.timezone, s.open_mode as OpenMode, hours.rows, new Set(closures.rows.map((r) => r.date)));
}
