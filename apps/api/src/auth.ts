import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import argon2 from 'argon2';
import { pool } from './db/pool.js';
import { config, isProd } from './config.js';
import { newToken, sha256 } from './lib/security.js';
import { forbidden, unauthorized, AppError } from './lib/errors.js';

export type Role = 'owner' | 'manager' | 'staff';
export interface AdminContext { userId: string; storeId: string; role: Role; name: string; email: string; sessionHash: string }

declare module 'fastify' {
  interface FastifyRequest { admin?: AdminContext }
}

export const SESSION_COOKIE = 'rg_sess';
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export const hashPassword = (pw: string) => argon2.hash(pw, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

export function validatePasswordStrength(pw: string): string | null {
  if (pw.length < 10) return 'A senha precisa ter pelo menos 10 caracteres.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'A senha precisa ter letras e números.';
  return null;
}

// Hash fixo para gastar o mesmo tempo quando o e-mail não existe (evita descobrir e-mails pelo tempo de resposta).
let dummyHash: string | null = null;

export async function login(email: string, password: string, ip: string, userAgent: string) {
  const { rows } = await pool.query(
    'SELECT id, store_id, password_hash, role, active, name, email, locked_until FROM admin_users WHERE email = $1',
    [email.toLowerCase().trim()],
  );
  const user = rows[0];
  if (!user) {
    dummyHash ??= await hashPassword('senha-inexistente-123');
    await argon2.verify(dummyHash, password).catch(() => false);
    throw new AppError(401, 'invalid_credentials', 'E-mail ou senha incorretos.');
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new AppError(429, 'account_locked', 'Muitas tentativas. Tente novamente em alguns minutos.');
  }
  const ok = await argon2.verify(user.password_hash, password).catch(() => false);
  if (!ok || !user.active) {
    await pool.query(
      `UPDATE admin_users SET failed_logins = failed_logins + 1,
         locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
       WHERE id = $1`,
      [user.id, MAX_FAILED, LOCK_MINUTES],
    );
    await pool.query(`INSERT INTO audit_log (store_id, user_id, action, ip) VALUES ($1,$2,'auth.login_failed',$3)`, [user.store_id, user.id, ip]);
    throw new AppError(401, 'invalid_credentials', 'E-mail ou senha incorretos.');
  }
  const token = newToken();
  await pool.query(
    `INSERT INTO admin_sessions (id_hash, user_id, store_id, expires_at, ip, user_agent)
     VALUES ($1,$2,$3, now() + make_interval(hours => $4), $5, $6)`,
    [sha256(token), user.id, user.store_id, config.SESSION_TTL_HOURS, ip, userAgent.slice(0, 300)],
  );
  await pool.query('UPDATE admin_users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
  await pool.query(`INSERT INTO audit_log (store_id, user_id, action, ip) VALUES ($1,$2,'auth.login',$3)`, [user.store_id, user.id, ip]);
  return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role as Role } };
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: config.SESSION_TTL_HOURS * 3600,
  });
}

export async function loadSession(request: FastifyRequest): Promise<AdminContext | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const hash = sha256(token);
  const { rows } = await pool.query(
    `UPDATE admin_sessions s SET last_seen_at = now()
       FROM admin_users u
      WHERE s.id_hash = $1 AND s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now() AND u.active
      RETURNING u.id, s.store_id, u.role, u.name, u.email`,
    [hash],
  );
  const r = rows[0];
  return r ? { userId: r.id, storeId: r.store_id, role: r.role, name: r.name, email: r.email, sessionHash: hash } : null;
}

export async function revokeSession(hash: string) {
  await pool.query('UPDATE admin_sessions SET revoked_at = now() WHERE id_hash = $1', [hash]);
}

const allowedOrigin = new URL(config.PUBLIC_URL).origin;

// Hook para todas as rotas /api/admin: exige sessão válida e protege contra CSRF.
export function registerAdminGuard(app: FastifyInstance) {
  app.addHook('preHandler', async (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      // Cabeçalho customizado força preflight CORS (que não é liberado) em requisições de outros sites.
      if (request.headers['x-requested-with'] !== 'rangasso') throw new AppError(403, 'csrf', 'Requisição bloqueada.');
      const origin = request.headers.origin;
      if (origin && origin !== allowedOrigin && isProd) throw new AppError(403, 'csrf', 'Origem não permitida.');
    }
    const ctx = await loadSession(request);
    if (!ctx) throw unauthorized();
    request.admin = ctx;
  });
}

export const requireRole = (...roles: Role[]) => async (request: FastifyRequest) => {
  if (!request.admin) throw unauthorized();
  if (!roles.includes(request.admin.role)) throw forbidden();
};
