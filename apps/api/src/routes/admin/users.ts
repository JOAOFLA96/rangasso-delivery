import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { pool, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { hashPassword, requireRole, validatePasswordStrength } from '../../auth.js';

const roleEnum = z.enum(['owner', 'manager', 'staff']);

export async function adminUserRoutes(app: FastifyInstance) {
  const ownerOnly = { preHandler: requireRole('owner') };
  const actor = (req: any) => ({ storeId: req.admin.storeId, userId: req.admin.userId, ip: req.ip });

  app.get('/users', ownerOnly, async (req) => {
    const r = await pool.query(
      'SELECT id, name, email, role, active, last_login_at, created_at FROM admin_users WHERE store_id = $1 ORDER BY active DESC, name',
      [req.admin!.storeId],
    );
    return { users: r.rows };
  });

  app.post('/users', ownerOnly, async (req) => {
    const b = parse(z.object({ name: z.string().trim().min(2).max(80), email: z.string().email().max(120), role: roleEnum, password: z.string().max(200) }), req.body);
    const weak = validatePasswordStrength(b.password);
    if (weak) throw badRequest('weak_password', weak);
    return tx(async (db) => {
      try {
        const r = await db.query(
          'INSERT INTO admin_users (store_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [req.admin!.storeId, b.email.toLowerCase(), b.name, await hashPassword(b.password), b.role],
        );
        await audit(db, actor(req), 'user.create', 'admin_user', r.rows[0].id, { email: b.email, role: b.role });
        return { id: r.rows[0].id };
      } catch (e: any) {
        if (e.code === '23505') throw badRequest('duplicate_email', 'Já existe um usuário com esse e-mail.');
        throw e;
      }
    });
  });

  app.put<{ Params: { id: string } }>('/users/:id', ownerOnly, async (req) => {
    const id = parse(z.string().uuid(), req.params.id);
    const b = parse(z.object({ name: z.string().trim().min(2).max(80), role: roleEnum, active: z.boolean(), password: z.string().max(200).optional() }), req.body);
    if (id === req.admin!.userId && (b.role !== 'owner' || !b.active)) throw badRequest('self_lockout', 'Você não pode remover seu próprio acesso de dono.');
    if (b.password) {
      const weak = validatePasswordStrength(b.password);
      if (weak) throw badRequest('weak_password', weak);
    }
    return tx(async (db) => {
      const r = await db.query(
        `UPDATE admin_users SET name=$3, role=$4, active=$5, password_hash = COALESCE($6, password_hash), failed_logins = 0, locked_until = NULL
          WHERE id=$1 AND store_id=$2`,
        [id, req.admin!.storeId, b.name, b.role, b.active, b.password ? await hashPassword(b.password) : null],
      );
      if (!r.rowCount) throw notFound('Usuário');
      const owners = await db.query(`SELECT count(*)::int AS n FROM admin_users WHERE store_id = $1 AND role = 'owner' AND active`, [req.admin!.storeId]);
      if (owners.rows[0].n === 0) throw badRequest('last_owner', 'A loja precisa de pelo menos um dono ativo.');
      // Desativar ou trocar senha derruba as sessões abertas do usuário.
      if (!b.active || b.password) await db.query('UPDATE admin_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      await audit(db, actor(req), 'user.update', 'admin_user', id, { name: b.name, role: b.role, active: b.active, passwordChanged: !!b.password });
      return { ok: true };
    });
  });

  app.post('/me/password', async (req) => {
    const b = parse(z.object({ currentPassword: z.string().max(200), newPassword: z.string().max(200) }), req.body);
    const weak = validatePasswordStrength(b.newPassword);
    if (weak) throw badRequest('weak_password', weak);
    const u = (await pool.query('SELECT password_hash FROM admin_users WHERE id = $1', [req.admin!.userId])).rows[0];
    if (!(await argon2.verify(u.password_hash, b.currentPassword).catch(() => false))) throw new AppError(400, 'invalid_password', 'Senha atual incorreta.');
    await tx(async (db) => {
      await db.query('UPDATE admin_users SET password_hash = $2 WHERE id = $1', [req.admin!.userId, await hashPassword(b.newPassword)]);
      await db.query('UPDATE admin_sessions SET revoked_at = now() WHERE user_id = $1 AND id_hash <> $2 AND revoked_at IS NULL', [req.admin!.userId, req.admin!.sessionHash]);
      await audit(db, actor(req), 'user.password_change', 'admin_user', req.admin!.userId);
    });
    return { ok: true };
  });

  app.get('/audit', { preHandler: requireRole('owner', 'manager') }, async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).default(0), action: z.string().max(60).optional() }), req.query);
    const params: unknown[] = [req.admin!.storeId];
    let filter = '';
    if (q.action) {
      params.push(`${q.action}%`);
      filter = `AND a.action LIKE $${params.length}`;
    }
    params.push(q.limit, q.offset);
    const r = await pool.query(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.data, a.ip, a.created_at, u.name AS user_name, d.name AS device_name
         FROM audit_log a LEFT JOIN admin_users u ON u.id = a.user_id LEFT JOIN print_devices d ON d.id = a.device_id
        WHERE a.store_id = $1 ${filter} ORDER BY a.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { entries: r.rows };
  });
}
