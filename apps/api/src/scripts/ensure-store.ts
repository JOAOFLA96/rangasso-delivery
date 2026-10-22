import type { Db } from '../db/pool.js';
import { config } from '../config.js';

export async function ensureStore(db: Db, name = 'Rangasso') {
  const found = await db.query('SELECT id FROM stores WHERE slug = $1', [config.STORE_SLUG]);
  if (found.rows[0]) return found.rows[0].id as string;
  const s = await db.query('INSERT INTO stores (slug, name) VALUES ($1,$2) RETURNING id', [config.STORE_SLUG, name]);
  const id = s.rows[0].id as string;
  await db.query(`INSERT INTO store_settings (store_id, display_name, tagline) VALUES ($1,$2,'Rango de Verdade')`, [id, name]);
  await db.query('INSERT INTO store_counters (store_id) VALUES ($1)', [id]);
  return id;
}
