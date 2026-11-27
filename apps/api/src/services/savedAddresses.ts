import type { Db } from '../db/pool.js';
import { cleanText, onlyDigits } from '../lib/text.js';
import type { GeoAddress } from './geocode.js';

// Endereços medidos pelo Google, guardados como plano B para quando o Google não responder.
const key = (a: Pick<GeoAddress, 'cep' | 'number'>) => ({ cep: onlyDigits(a.cep ?? ''), number: onlyDigits(a.number ?? '') || cleanText(a.number ?? '', 15).toLowerCase() });

export async function saveMeasuredAddress(db: Db, storeId: string, a: GeoAddress, km: number, feeCents: number | null) {
  const k = key(a);
  if (k.cep.length !== 8) return;
  await db.query(
    `INSERT INTO delivery_addresses (store_id, cep, number, street, neighborhood, city, distance_km, fee_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (store_id, cep, number) DO UPDATE SET street = EXCLUDED.street, neighborhood = EXCLUDED.neighborhood,
       city = EXCLUDED.city, distance_km = EXCLUDED.distance_km, fee_cents = EXCLUDED.fee_cents,
       uses = delivery_addresses.uses + 1, updated_at = now()`,
    [storeId, k.cep, k.number, cleanText(a.street ?? '', 120), cleanText(a.neighborhood ?? '', 80), cleanText(a.city ?? '', 80), km, feeCents],
  );
}

export interface SavedDistance { km: number; match: 'address' | 'cep' }

// Mesmo CEP e número: a distância medida daquele endereço. Só o mesmo CEP: a maior distância já medida nele
// (para não cobrar menos do que custa). Nada guardado: null.
export async function savedDistance(db: Db, storeId: string, a: GeoAddress): Promise<SavedDistance | null> {
  const k = key(a);
  if (k.cep.length !== 8) return null;
  const exact = await db.query('SELECT distance_km FROM delivery_addresses WHERE store_id = $1 AND cep = $2 AND number = $3', [storeId, k.cep, k.number]);
  if (exact.rows[0]) return { km: Number(exact.rows[0].distance_km), match: 'address' };
  const cep = await db.query('SELECT max(distance_km) AS km FROM delivery_addresses WHERE store_id = $1 AND cep = $2', [storeId, k.cep]);
  return cep.rows[0]?.km != null ? { km: Number(cep.rows[0].km), match: 'cep' } : null;
}
