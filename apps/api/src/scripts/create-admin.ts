// Cria (ou redefine a senha de) um usuário administrador.
// Uso: npm run create-admin -- --email dono@exemplo.com --name "João" [--role owner|manager|staff]
// A senha é gerada aleatoriamente e mostrada uma única vez (ou lida de ADMIN_PASSWORD, se definida).
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { hashPassword, validatePasswordStrength } from '../auth.js';
import { ensureStore } from './ensure-store.js';

const { values } = parseArgs({
  options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'owner' }, reset: { type: 'boolean', default: false } },
});
if (!values.email || !values.name) {
  console.error('Uso: npm run create-admin -- --email EMAIL --name NOME [--role owner|manager|staff] [--reset]');
  process.exit(1);
}
if (!['owner', 'manager', 'staff'].includes(values.role!)) {
  console.error('role inválido');
  process.exit(1);
}

await migrate(() => {});
const storeId = await ensureStore(pool);
const password = process.env.ADMIN_PASSWORD || `${randomBytes(9).toString('base64url')}7a`;
const weak = validatePasswordStrength(password);
if (weak) {
  console.error(weak);
  process.exit(1);
}
const email = values.email.toLowerCase().trim();
const existing = await pool.query('SELECT id FROM admin_users WHERE email = $1', [email]);
if (existing.rows[0] && !values.reset) {
  console.error('Usuário já existe. Use --reset para gerar nova senha.');
  process.exit(1);
}
if (existing.rows[0]) {
  await pool.query('UPDATE admin_users SET password_hash = $2, active = true, failed_logins = 0, locked_until = NULL WHERE id = $1', [existing.rows[0].id, await hashPassword(password)]);
  await pool.query('UPDATE admin_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [existing.rows[0].id]);
  await pool.query(`INSERT INTO audit_log (store_id, user_id, action) VALUES ($1,$2,'user.password_reset_cli')`, [storeId, existing.rows[0].id]);
} else {
  const r = await pool.query('INSERT INTO admin_users (store_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id', [storeId, email, values.name, await hashPassword(password), values.role]);
  await pool.query(`INSERT INTO audit_log (store_id, user_id, action) VALUES ($1,$2,'user.create_cli')`, [storeId, r.rows[0].id]);
}
console.log(`\nUsuário: ${email}`);
if (!process.env.ADMIN_PASSWORD) console.log(`Senha temporária (anote agora, não será mostrada de novo): ${password}`);
console.log('Troque a senha no painel em Configurações > Minha conta.\n');
await pool.end();
