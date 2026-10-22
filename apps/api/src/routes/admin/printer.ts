import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { emitStoreEvent } from '../../lib/events.js';
import { notFound } from '../../lib/errors.js';
import { newToken, sha256 } from '../../lib/security.js';
import { parse } from '../../lib/validate.js';
import { requireRole } from '../../auth.js';
import { createPrintJob } from '../../services/print.js';

export const AGENT_ONLINE_SECONDS = 90;

export async function adminPrinterRoutes(app: FastifyInstance) {
  const canEdit = { preHandler: requireRole('owner', 'manager') };
  const actor = (req: any) => ({ storeId: req.admin.storeId, userId: req.admin.userId, ip: req.ip });

  app.get('/printer/status', async (req) => {
    const storeId = req.admin!.storeId;
    const devices = await pool.query(
      `SELECT id, name, token_prefix, created_at, revoked_at, last_seen_at, last_ip, agent_version, printer_state, last_error, last_error_at,
              (revoked_at IS NULL AND last_seen_at > now() - make_interval(secs => $2)) AS online
         FROM print_devices WHERE store_id = $1 ORDER BY revoked_at NULLS FIRST, created_at DESC`,
      [storeId, AGENT_ONLINE_SECONDS],
    );
    const queue = await pool.query(
      `SELECT j.id, j.kind, j.reprint_number, j.status, j.attempts, j.max_attempts, j.next_attempt_at, j.last_error, j.created_at,
              o.number AS order_number, o.id AS order_id
         FROM print_jobs j LEFT JOIN orders o ON o.id = j.order_id
        WHERE j.store_id = $1 AND (j.status IN ('pending','claimed','sending','failed','uncertain') OR j.created_at > now() - interval '12 hours')
        ORDER BY j.created_at DESC LIMIT 100`,
      [storeId],
    );
    return { devices: devices.rows, queue: queue.rows, onlineThresholdSeconds: AGENT_ONLINE_SECONDS };
  });

  // Cria a credencial do agente. O token aparece só nesta resposta; no banco fica apenas o hash.
  app.post('/printer/devices', canEdit, async (req) => {
    const b = parse(z.object({ name: z.string().trim().min(1).max(60) }), req.body);
    const token = `rgd_${newToken(32)}`;
    return tx(async (db) => {
      const r = await db.query(
        `INSERT INTO print_devices (store_id, name, token_hash, token_prefix, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [req.admin!.storeId, b.name, sha256(token), token.slice(0, 10), req.admin!.userId],
      );
      await audit(db, actor(req), 'device.create', 'print_device', r.rows[0].id, { name: b.name });
      return { id: r.rows[0].id, token };
    });
  });

  app.post<{ Params: { id: string } }>('/printer/devices/:id/revoke', canEdit, async (req) => {
    const id = parse(z.string().uuid(), req.params.id);
    return tx(async (db) => {
      const r = await db.query('UPDATE print_devices SET revoked_at = now() WHERE id = $1 AND store_id = $2 AND revoked_at IS NULL', [id, req.admin!.storeId]);
      if (!r.rowCount) throw notFound('Agente');
      // Trabalhos presos com este agente voltam para a fila / ficam incertos pela regra de lease.
      await db.query(`UPDATE print_jobs SET lease_expires_at = now() WHERE device_id = $1 AND status IN ('claimed','sending')`, [id]);
      await audit(db, actor(req), 'device.revoke', 'print_device', id);
      return { ok: true };
    });
  });

  app.post('/printer/test', async (req) => {
    const job = await tx(async (db) => {
      const j = await createPrintJob(db, req.admin!.storeId, { kind: 'test', requestedBy: req.admin!.userId });
      await audit(db, actor(req), 'print.test', 'print_job', j.id);
      return j;
    });
    emitStoreEvent(req.admin!.storeId, { type: 'print.queued', jobId: job.id });
    return { jobId: job.id };
  });
}
