import type { Db } from '../db/pool.js';
import { hashPassword, validatePasswordStrength } from '../auth.js';
import { ensureStore } from './ensure-store.js';

// Primeiro acesso em hospedagens sem terminal (Render, Railway): se INITIAL_ADMIN_EMAIL e INITIAL_ADMIN_PASSWORD
// estiverem definidos e a loja ainda não tiver nenhum usuário, cria o dono. Com algum usuário já existente, não faz nada.
export async function bootstrapAdmin(db: Db, log: (m: string) => void) {
  const email = process.env.INITIAL_ADMIN_EMAIL?.toLowerCase().trim();
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!email || !password) return;
  const storeId = await ensureStore(db);
  const count = Number((await db.query('SELECT count(*) FROM admin_users WHERE store_id = $1', [storeId])).rows[0].count);
  if (count > 0) return;
  const weak = validatePasswordStrength(password);
  if (weak) return log(`INITIAL_ADMIN_PASSWORD recusada: ${weak}`);
  const r = await db.query(`INSERT INTO admin_users (store_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,'owner') RETURNING id`, [
    storeId, email, process.env.INITIAL_ADMIN_NAME?.trim() || 'Dono', await hashPassword(password),
  ]);
  await db.query(`INSERT INTO audit_log (store_id, user_id, action) VALUES ($1,$2,'user.create_bootstrap')`, [storeId, r.rows[0].id]);
  log(`Primeiro usuário criado: ${email}. Troque a senha no painel e remova INITIAL_ADMIN_PASSWORD da hospedagem.`);
}
