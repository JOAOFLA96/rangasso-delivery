import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { parse } from '../lib/validate.js';
import { AppError, unauthorized } from '../lib/errors.js';
import { SESSION_COOKIE, loadSession, login, revokeSession, setSessionCookie } from '../auth.js';

export async function authRoutes(app: FastifyInstance) {
  app.post('/login', { config: { rateLimit: { max: config.LOGIN_RATE_LIMIT, timeWindow: '5 minutes' } } }, async (req, reply) => {
    if (req.headers['x-requested-with'] !== 'rangasso') throw new AppError(403, 'csrf', 'Requisição bloqueada.');
    const body = parse(z.object({ email: z.string().email().max(120), password: z.string().min(1).max(200) }), req.body);
    const { token, user } = await login(body.email, body.password, req.ip, String(req.headers['user-agent'] ?? ''));
    setSessionCookie(reply, token);
    return { user };
  });

  app.post('/logout', async (req, reply) => {
    const ctx = await loadSession(req);
    if (ctx) {
      await revokeSession(ctx.sessionHash);
      await pool.query(`INSERT INTO audit_log (store_id, user_id, action, ip) VALUES ($1,$2,'auth.logout',$3)`, [ctx.storeId, ctx.userId, req.ip]);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', async (req) => {
    const ctx = await loadSession(req);
    if (!ctx) throw unauthorized();
    return { user: { id: ctx.userId, name: ctx.name, email: ctx.email, role: ctx.role } };
  });
}
