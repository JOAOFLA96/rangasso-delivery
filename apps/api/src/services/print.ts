import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { formatPhone } from '../lib/text.js';

export const PRINT_STATUS_LABELS: Record<string, string> = {
  not_queued: 'Aguardando impressão',
  pending: 'Na fila',
  claimed: 'Recebido pelo agente',
  sending: 'Enviando à impressora',
  sent: 'Enviado à impressora',
  printed: 'Impresso',
  failed: 'Falha na impressão',
  uncertain: 'Resultado incerto',
  cancelled: 'Cancelado',
};

const CLAIM_LEASE_SECONDS = 60;
const SENDING_LEASE_SECONDS = 120;
const BACKOFF_SECONDS = [5, 15, 30, 60, 120, 300];
export const backoffSeconds = (attempt: number) => BACKOFF_SECONDS[Math.min(Math.max(attempt - 1, 0), BACKOFF_SECONDS.length - 1)];

// Dados da comanda congelados no momento em que o trabalho é criado.
export async function buildReceiptPayload(db: Db, storeId: string, orderId: string) {
  const s = (await db.query('SELECT * FROM store_settings WHERE store_id = $1', [storeId])).rows[0];
  const o = (await db.query('SELECT * FROM orders WHERE id = $1 AND store_id = $2', [orderId, storeId])).rows[0];
  if (!o) throw notFound('Pedido');
  const items = (await db.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY position', [orderId])).rows;
  const addons = (await db.query(
    'SELECT a.* FROM order_item_addons a JOIN order_items i ON i.id = a.order_item_id WHERE i.order_id = $1',
    [orderId],
  )).rows;
  return {
    store: { name: s.display_name, phone: s.phone, footer: s.receipt_footer, timezone: s.timezone },
    columns: s.paper_columns,
    order: {
      number: o.number,
      createdAt: o.created_at,
      status: o.status,
      customerName: o.customer_name,
      customerPhone: formatPhone(o.customer_phone),
      address: {
        street: o.street, number: o.street_number, complement: o.complement, reference: o.reference,
        neighborhood: o.neighborhood_name, city: o.city, cep: o.cep,
      },
      notes: o.notes,
      items: items.map((i) => ({
        quantity: i.quantity,
        name: i.product_name,
        unitPriceCents: i.unit_price_cents,
        lineTotalCents: i.line_total_cents,
        notes: i.notes,
        addons: addons.filter((a) => a.order_item_id === i.id).map((a) => ({ group: a.group_name, name: a.addon_name, priceCents: a.price_cents })),
      })),
      subtotalCents: o.subtotal_cents,
      deliveryFeeCents: o.delivery_fee_cents,
      discountCents: o.discount_cents,
      totalCents: o.total_cents,
      paymentMethod: o.payment_method,
      changeForCents: o.change_for_cents,
    },
  };
}

export async function createPrintJob(
  db: Db,
  storeId: string,
  opts: { orderId?: string; kind: 'original' | 'reprint' | 'test'; requestedBy?: string; reason?: string },
) {
  const s = (await db.query('SELECT print_copies, paper_columns, display_name, receipt_footer, timezone FROM store_settings WHERE store_id = $1', [storeId])).rows[0];
  let payload: object;
  let reprintNumber = 0;
  if (opts.kind === 'test') {
    payload = { test: true, store: { name: s.display_name, footer: s.receipt_footer, timezone: s.timezone }, columns: s.paper_columns, createdAt: new Date().toISOString() };
  } else {
    if (!opts.orderId) throw badRequest('order_required', 'Pedido obrigatório.');
    payload = await buildReceiptPayload(db, storeId, opts.orderId);
    if (opts.kind === 'reprint') {
      const r = await db.query(`SELECT count(*)::int AS n FROM print_jobs WHERE order_id = $1 AND kind = 'reprint'`, [opts.orderId]);
      reprintNumber = r.rows[0].n + 1;
    }
  }
  const job = (await db.query(
    `INSERT INTO print_jobs (store_id, order_id, kind, reprint_number, copies, payload, requested_by, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, kind, reprint_number`,
    [storeId, opts.orderId ?? null, opts.kind, reprintNumber, opts.kind === 'test' ? 1 : s.print_copies, JSON.stringify(payload), opts.requestedBy ?? null, opts.reason ?? ''],
  )).rows[0];
  await db.query(`INSERT INTO print_job_events (job_id, store_id, event, detail) VALUES ($1,$2,'created',$3)`, [job.id, storeId, opts.kind]);
  if (opts.orderId) await syncOrderPrintStatus(db, opts.orderId);
  return job as { id: string; kind: string; reprint_number: number };
}

// O status de impressão do pedido acompanha o trabalho mais recente (original ou reimpressão).
export async function syncOrderPrintStatus(db: Db, orderId: string) {
  await db.query(
    `UPDATE orders SET print_status = COALESCE((
        SELECT CASE WHEN status = 'cancelled' THEN 'not_queued' ELSE status END
          FROM print_jobs WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1), 'not_queued')
      WHERE id = $1`,
    [orderId],
  );
}

// Recupera leases vencidos: "claimed" volta para a fila (nada foi enviado);
// "sending" vira "uncertain" (pode ter impresso) e exige decisão humana para não duplicar.
export async function recoverExpiredLeases(storeId: string) {
  const r = await pool.query(
    `UPDATE print_jobs SET
        status = CASE WHEN status = 'claimed' THEN 'pending' ELSE 'uncertain' END,
        last_error = CASE WHEN status = 'claimed' THEN 'Agente não confirmou o recebimento a tempo; trabalho voltou para a fila.'
                          ELSE 'Agente perdeu contato durante o envio. Confira se a comanda saiu antes de reimprimir.' END,
        lease_expires_at = NULL, updated_at = now()
      WHERE store_id = $1 AND status IN ('claimed','sending') AND lease_expires_at < now()
      RETURNING id, order_id, status`,
    [storeId],
  );
  for (const j of r.rows) {
    await pool.query(`INSERT INTO print_job_events (job_id, store_id, event, detail) VALUES ($1,$2,'lease_expired',$3)`, [j.id, storeId, j.status]);
    if (j.order_id) await syncOrderPrintStatus(pool, j.order_id);
  }
  return r.rows as { id: string; order_id: string | null; status: string }[];
}

export async function claimJobs(storeId: string, deviceId: string, limit = 5) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE print_jobs j SET status = 'claimed', device_id = $2, attempts = attempts + 1, claimed_at = now(),
              lease_expires_at = now() + make_interval(secs => $4), updated_at = now()
        WHERE j.id IN (
          SELECT id FROM print_jobs
           WHERE store_id = $1 AND status IN ('pending','failed') AND attempts < max_attempts AND next_attempt_at <= now()
           ORDER BY created_at
           LIMIT $3 FOR UPDATE SKIP LOCKED)
        RETURNING j.id, j.order_id, j.kind, j.reprint_number, j.copies, j.payload, j.attempts, j.created_at`,
      [storeId, deviceId, limit, CLAIM_LEASE_SECONDS],
    );
    for (const j of r.rows) {
      await client.query(`INSERT INTO print_job_events (job_id, store_id, device_id, event, detail) VALUES ($1,$2,$3,'claimed',$4)`, [j.id, storeId, deviceId, `tentativa ${j.attempts}`]);
      if (j.order_id) await syncOrderPrintStatus(client, j.order_id);
    }
    await client.query('COMMIT');
    return r.rows.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export type AgentReport = 'sending' | 'sent' | 'printed' | 'failed' | 'uncertain';
const ALLOWED_FROM: Record<AgentReport, string[]> = {
  sending: ['claimed'],
  sent: ['claimed', 'sending'],
  printed: ['claimed', 'sending', 'sent'],
  failed: ['claimed', 'sending'],
  uncertain: ['claimed', 'sending'],
};

export async function reportJob(storeId: string, deviceId: string, jobId: string, status: AgentReport, detail: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const j = (await client.query('SELECT * FROM print_jobs WHERE id = $1 AND store_id = $2 FOR UPDATE', [jobId, storeId])).rows[0];
    if (!j) throw notFound('Trabalho de impressão');
    if (j.status === status) {
      await client.query('COMMIT');
      return { status: j.status, duplicate: true };
    }
    if (j.device_id !== deviceId) throw new AppError(409, 'not_owner', 'Trabalho pertence a outro agente.');
    if (!ALLOWED_FROM[status].includes(j.status)) throw new AppError(409, 'invalid_job_transition', `Não é possível ir de ${j.status} para ${status}.`);

    let sql = '';
    const params: unknown[] = [jobId];
    if (status === 'sending') {
      sql = `status='sending', lease_expires_at = now() + make_interval(secs => ${SENDING_LEASE_SECONDS})`;
    } else if (status === 'sent') {
      sql = `status='sent', sent_at = now(), lease_expires_at = NULL, last_error = NULL`;
    } else if (status === 'printed') {
      sql = `status='printed', sent_at = COALESCE(sent_at, now()), printed_at = now(), lease_expires_at = NULL, last_error = NULL`;
    } else if (status === 'uncertain') {
      sql = `status='uncertain', lease_expires_at = NULL, last_error = $2`;
      params.push(detail || 'Resultado incerto informado pelo agente.');
    } else {
      sql = `status='failed', lease_expires_at = NULL, last_error = $2,
             next_attempt_at = now() + make_interval(secs => $3)`;
      params.push(detail || 'Falha sem detalhe', backoffSeconds(j.attempts));
    }
    await client.query(`UPDATE print_jobs SET ${sql}, updated_at = now() WHERE id = $1`, params);
    await client.query(`INSERT INTO print_job_events (job_id, store_id, device_id, event, detail) VALUES ($1,$2,$3,$4,$5)`, [jobId, storeId, deviceId, status, detail.slice(0, 500)]);
    if (status === 'failed') {
      await client.query('UPDATE print_devices SET last_error = $2, last_error_at = now() WHERE id = $1', [deviceId, detail.slice(0, 500)]);
    }
    if (j.order_id) await syncOrderPrintStatus(client, j.order_id);
    await client.query('COMMIT');
    return { status, duplicate: false, orderId: j.order_id as string | null };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Ações humanas no painel sobre um trabalho com falha definitiva ou resultado incerto.
export async function resolveJob(db: Db, storeId: string, jobId: string, action: 'retry' | 'mark_printed' | 'cancel', userId: string) {
  const j = (await db.query('SELECT * FROM print_jobs WHERE id = $1 AND store_id = $2 FOR UPDATE', [jobId, storeId])).rows[0];
  if (!j) throw notFound('Trabalho de impressão');
  const allowed: Record<string, string[]> = {
    retry: ['failed', 'uncertain'],
    mark_printed: ['uncertain', 'sent', 'failed'],
    cancel: ['pending', 'failed', 'uncertain'],
  };
  if (!allowed[action].includes(j.status)) throw badRequest('invalid_job_action', 'Ação não permitida para o estado atual da impressão.');
  if (action === 'retry') {
    await db.query(`UPDATE print_jobs SET status='pending', attempts = 0, next_attempt_at = now(), device_id = NULL, updated_at = now() WHERE id = $1`, [jobId]);
  } else if (action === 'mark_printed') {
    await db.query(`UPDATE print_jobs SET status='printed', printed_at = now(), last_error = NULL, updated_at = now() WHERE id = $1`, [jobId]);
  } else {
    await db.query(`UPDATE print_jobs SET status='cancelled', updated_at = now() WHERE id = $1`, [jobId]);
  }
  await db.query(`INSERT INTO print_job_events (job_id, store_id, event, detail) VALUES ($1,$2,$3,$4)`, [jobId, storeId, `manual_${action}`, `usuário ${userId}`]);
  if (j.order_id) await syncOrderPrintStatus(db, j.order_id);
  return j as { id: string; order_id: string | null };
}
