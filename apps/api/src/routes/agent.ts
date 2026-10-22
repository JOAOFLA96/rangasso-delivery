import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { emitStoreEvent, onStoreEvent } from '../lib/events.js';
import { AppError } from '../lib/errors.js';
import { sha256 } from '../lib/security.js';
import { parse } from '../lib/validate.js';
import { claimJobs, recoverExpiredLeases, reportJob } from '../services/print.js';
import { agentBundle } from '../services/agentBundle.js';

declare module 'fastify' {
  interface FastifyRequest { device?: { id: string; storeId: string; name: string } }
}

async function authDevice(req: FastifyRequest) {
  const auth = req.headers.authorization ?? '';
  const m = /^Bearer (rgd_[A-Za-z0-9_-]{20,80})$/.exec(auth);
  if (!m) throw new AppError(401, 'device_unauthorized', 'Credencial do agente ausente ou inválida.');
  const r = await pool.query(
    `UPDATE print_devices SET last_seen_at = now(), last_ip = $2
      WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id, store_id, name`,
    [sha256(m[1]), req.ip],
  );
  if (!r.rows[0]) throw new AppError(401, 'device_unauthorized', 'Credencial do agente inválida ou revogada.');
  req.device = { id: r.rows[0].id, storeId: r.rows[0].store_id, name: r.rows[0].name };
}

const heartbeatBody = z.object({
  agentVersion: z.string().max(40),
  printer: z.object({
    mode: z.string().max(30),
    target: z.string().max(200),
    online: z.boolean().nullable(),
    paperOut: z.boolean().nullable().optional(),
    coverOpen: z.boolean().nullable().optional(),
    error: z.string().max(500).nullable().optional(),
    checkedAt: z.string().max(40).optional(),
  }),
  localQueue: z.number().int().min(0).max(100000).optional(),
});

export async function agentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authDevice);

  // Atualização automática: o agente pergunta a versão publicada junto com este servidor e baixa o agent.cjs.
  app.get('/update', async () => {
    const b = await agentBundle();
    return b ? { version: b.version, sha256: b.sha256, size: b.size } : { version: null };
  });

  app.get('/update/agent.cjs', async (_req, reply) => {
    const b = await agentBundle();
    if (!b) throw new AppError(404, 'not_found', 'Nenhuma versão do agente publicada neste servidor.');
    reply.header('content-type', 'application/javascript; charset=utf-8').header('cache-control', 'no-store').header('x-agent-sha256', b.sha256);
    return reply.send(b.content);
  });

  app.post('/heartbeat', async (req) => {
    const b = parse(heartbeatBody, req.body);
    const d = req.device!;
    await pool.query(
      `UPDATE print_devices SET agent_version = $2, printer_state = $3,
          last_error = COALESCE($4, last_error), last_error_at = CASE WHEN $4::text IS NOT NULL THEN now() ELSE last_error_at END
        WHERE id = $1`,
      [d.id, b.agentVersion, JSON.stringify({ ...b.printer, localQueue: b.localQueue ?? 0 }), b.printer.error ?? null],
    );
    emitStoreEvent(d.storeId, { type: 'agent.updated', deviceId: d.id });
    // Configuração da impressora definida no painel; o agente usa quando o config local está em modo "auto".
    const s = (await pool.query(
      `SELECT printer_connection, printer_host, printer_port, printer_windows_name, paper_columns, printer_model FROM store_settings WHERE store_id = $1`,
      [d.storeId],
    )).rows[0];
    return {
      ok: true,
      serverTime: new Date().toISOString(),
      device: { name: d.name },
      printer: { connection: s.printer_connection, host: s.printer_host, port: s.printer_port, windowsName: s.printer_windows_name, columns: s.paper_columns, model: s.printer_model },
    };
  });

  // Long-poll: devolve trabalhos assim que existirem ou após `wait` segundos sem nada.
  app.get('/jobs', async (req) => {
    const q = parse(z.object({ wait: z.coerce.number().int().min(0).max(30).default(25) }), req.query);
    const d = req.device!;
    const recovered = await recoverExpiredLeases(d.storeId);
    for (const j of recovered) emitStoreEvent(d.storeId, { type: 'print.updated', jobId: j.id, orderId: j.order_id });

    let jobs = await claimJobs(d.storeId, d.id);
    if (!jobs.length && q.wait > 0) {
      // Acorda antes se houver retentativa agendada (falha com backoff) vencendo dentro da espera.
      const next = (await pool.query(
        `SELECT EXTRACT(EPOCH FROM (min(next_attempt_at) - now())) AS s FROM print_jobs
          WHERE store_id = $1 AND status IN ('pending','failed') AND attempts < max_attempts`,
        [d.storeId],
      )).rows[0]?.s;
      const waitMs = next == null ? q.wait * 1000 : Math.min(q.wait * 1000, Math.max(200, Number(next) * 1000 + 100));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, waitMs);
        const off = onStoreEvent(d.storeId, (ev) => ev.type === 'print.queued' && done());
        req.raw.on('close', done);
        function done() {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
      if (!req.raw.destroyed) jobs = await claimJobs(d.storeId, d.id);
    }
    for (const j of jobs) emitStoreEvent(d.storeId, { type: 'print.updated', jobId: j.id, orderId: j.order_id });
    return {
      jobs: jobs.map((j) => ({ id: j.id, claimId: new Date(j.claimed_at).toISOString(), kind: j.kind, reprintNumber: j.reprint_number, copies: j.copies, attempt: j.attempts, payload: j.payload, createdAt: j.created_at })),
    };
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/status', async (req) => {
    const id = parse(z.string().uuid(), req.params.id);
    const b = parse(z.object({ status: z.enum(['sending', 'sent', 'printed', 'failed', 'uncertain']), detail: z.string().max(500).default('') }), req.body);
    const d = req.device!;
    const r = await reportJob(d.storeId, d.id, id, b.status, b.detail);
    if (!r.duplicate) {
      emitStoreEvent(d.storeId, { type: 'print.updated', jobId: id, orderId: r.orderId ?? null });
      if (b.status === 'failed') emitStoreEvent(d.storeId, { type: 'print.queued', jobId: id });
    }
    return { ok: true, status: r.status };
  });
}
