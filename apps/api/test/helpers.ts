import { randomUUID } from 'node:crypto';
import { pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { ensureStore } from '../src/scripts/ensure-store.js';
import { resetStoreCache } from '../src/services/store.js';

export const PASSWORD = 'senhaForte123';

export async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(() => {});
  resetStoreCache();
}

export interface Fixture {
  storeId: string;
  burgerId: string;
  duploId: string;
  esgotadoId: string;
  sodaId: string;
  pontoAoPontoId: string;
  pontoMalId: string;
  baconId: string;
  hoodAId: string;
  hoodOffId: string;
}

export async function seed(): Promise<Fixture> {
  const storeId = await ensureStore(pool);
  await pool.query(`UPDATE store_settings SET open_mode = 'force_open', min_order_cents = 2000 WHERE store_id = $1`, [storeId]);
  const cat = (await pool.query(`INSERT INTO categories (store_id, name) VALUES ($1,'Lanches') RETURNING id`, [storeId])).rows[0].id;
  const p = async (name: string, price: number, extra = '') =>
    (await pool.query(`INSERT INTO products (store_id, category_id, name, price_cents ${extra ? ',' + extra.split('=')[0] : ''}) VALUES ($1,$2,$3,$4 ${extra ? ',' + extra.split('=')[1] : ''}) RETURNING id`, [storeId, cat, name, price])).rows[0].id;
  const burgerId = await p('Burger', 3000);
  const duploId = await p('Duplo', 4000);
  await pool.query(`UPDATE products SET promo_price_cents = 3500, promo_active = true WHERE id = $1`, [duploId]);
  const esgotadoId = await p('Esgotado', 1000, 'available=false');
  const sodaId = await p('Refri', 700);
  await pool.query(`UPDATE products SET track_stock = true, stock_qty = 3 WHERE id = $1`, [sodaId]);
  const g1 = (await pool.query(`INSERT INTO addon_groups (store_id, product_id, name, min_select, max_select) VALUES ($1,$2,'Ponto',1,1) RETURNING id`, [storeId, burgerId])).rows[0].id;
  const pontoMalId = (await pool.query(`INSERT INTO addons (store_id, group_id, name, price_cents) VALUES ($1,$2,'Mal passado',0) RETURNING id`, [storeId, g1])).rows[0].id;
  const pontoAoPontoId = (await pool.query(`INSERT INTO addons (store_id, group_id, name, price_cents) VALUES ($1,$2,'Ao ponto',0) RETURNING id`, [storeId, g1])).rows[0].id;
  const g2 = (await pool.query(`INSERT INTO addon_groups (store_id, product_id, name, min_select, max_select) VALUES ($1,$2,'Extras',0,2) RETURNING id`, [storeId, burgerId])).rows[0].id;
  const baconId = (await pool.query(`INSERT INTO addons (store_id, group_id, name, price_cents) VALUES ($1,$2,'Bacon',500) RETURNING id`, [storeId, g2])).rows[0].id;
  const hoodAId = (await pool.query(`INSERT INTO neighborhoods (store_id, name, fee_cents) VALUES ($1,'Centro',600) RETURNING id`, [storeId])).rows[0].id;
  const hoodOffId = (await pool.query(`INSERT INTO neighborhoods (store_id, name, fee_cents, active) VALUES ($1,'Longe',0,false) RETURNING id`, [storeId])).rows[0].id;
  for (const [email, role] of [['dono@t.local', 'owner'], ['gerente@t.local', 'manager'], ['atendente@t.local', 'staff']]) {
    await pool.query('INSERT INTO admin_users (store_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,$5)', [storeId, email, email.split('@')[0], await hashPassword(PASSWORD), role]);
  }
  return { storeId, burgerId, duploId, esgotadoId, sodaId, pontoAoPontoId, pontoMalId, baconId, hoodAId, hoodOffId };
}

export async function makeApp() {
  return buildApp({ logger: false });
}

export function orderBody(f: Fixture, overrides: Record<string, any> = {}) {
  return {
    idempotencyKey: randomUUID(),
    customer: { name: 'Cliente Teste', phone: '(11) 98765-4321' },
    address: { cep: '01001-000', street: 'Rua A', number: '10', neighborhoodId: f.hoodAId, complement: 'ap 1', reference: '' },
    notes: 'sem cebola',
    payment: { method: 'cash', changeForCents: 10000 },
    items: [{ productId: f.burgerId, quantity: 2, notes: '', addonIds: [f.pontoAoPontoId, f.baconId] }],
    acceptPrivacy: true,
    ...overrides,
  };
}

export async function loginAs(app: Awaited<ReturnType<typeof makeApp>>, email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'rangasso' }, payload: { email, password: PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login falhou: ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'rg_sess')!;
  return { cookie: `rg_sess=${cookie.value}`, 'x-requested-with': 'rangasso' };
}

export { pool };
