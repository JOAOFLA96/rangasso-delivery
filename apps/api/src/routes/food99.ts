import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { pool, tx } from '../db/pool.js';
import { emitStoreEvent } from '../lib/events.js';
import { changeStatus } from '../services/orders.js';
import { currentStoreId } from '../services/store.js';
import {
  food99Api, food99Enabled, importOrder, logEvent, parseJsonBig, setExternalFlags, shopToken, verifyWebhook,
} from '../services/food99.js';

// Webhook do 99Food: o endereço cadastrado no app do portal (callback address) é
//   {PUBLIC_URL}/api/integrations/99food/webhook
// O 99 espera resposta JSON com errno 0 em até 6 segundos; com outro errno, reenvia o aviso.
export async function food99Routes(app: FastifyInstance) {
  // Corpo cru: a assinatura é calculada sobre o texto exato recebido.
  app.addContentTypeParser(['application/json', 'text/plain'], { parseAs: 'string', bodyLimit: 512 * 1024 }, (_req, body, done) => done(null, body));
  app.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 512 * 1024 }, (_req, body, done) => done(null, body));

  const ok = (reply: FastifyReply) => reply.code(200).send({ errno: 0, errmsg: 'ok' });
  const fail = (reply: FastifyReply, code: number, msg: string) => reply.code(code).send({ errno: 1, errmsg: msg });

  app.post('/webhook', async (req, reply) => {
    if (!food99Enabled()) return fail(reply, 503, 'integration disabled');
    const raw = typeof req.body === 'string' ? req.body : '';
    if (!verifyWebhook(raw, req.headers['didi-header-sign'] as string | undefined)) {
      await logEvent(null, 'assinatura_invalida', null, null, 'Aviso recusado: assinatura não confere');
      return fail(reply, 401, 'invalid sign');
    }
    let ev: any;
    try {
      ev = parseJsonBig(raw);
    } catch {
      return fail(reply, 400, 'invalid json');
    }
    if (ev?.app_id != null && String(ev.app_id) !== config.FOOD99_APP_ID) return fail(reply, 403, 'app_id mismatch');
    const storeId = await currentStoreId();
    const type = String(ev?.type ?? '');
    const shop = ev?.app_shop_id != null ? String(ev.app_shop_id) : null;
    const data = typeof ev?.data === 'string' ? safeParse(ev.data) : ev?.data;
    const orderId = data?.order_id != null ? String(data.order_id) : null;

    try {
      switch (type) {
        case 'orderNew': {
          if (!shop) return fail(reply, 400, 'missing app_shop_id');
          await ensureShop(storeId, shop);
          const { order, created } = await importOrder(storeId, shop, data);
          await logEvent(storeId, type, shop, orderId, created ? `Pedido #${order.number} criado` : `Repetido (pedido #${order.number})`);
          if (created) {
            emitStoreEvent(storeId, { type: 'order.created', orderId: order.id, number: order.number });
            emitStoreEvent(storeId, { type: 'print.queued', jobId: '' });
            // Aceite automático depois de responder ao 99 (o aviso tem só 6 s de prazo).
            if (config.FOOD99_AUTO_CONFIRM === 'true') setImmediate(() => autoConfirm(storeId, order.id).catch((e) => req.log.warn({ err: e }, '99food: falha no aceite automático')));
          }
          return ok(reply);
        }
        case 'orderConfirm':
          await syncFrom99(storeId, orderId, 'confirmed', 'Aceito no 99Food', { confirmed: true });
          break;
        case 'orderReady':
          await syncFrom99(storeId, orderId, null, '', { ready: true });
          break;
        case 'orderCancel':
          await syncFrom99(storeId, orderId, 'cancelled', 'Cancelado no 99Food (pelo cliente ou pelo 99)', {});
          break;
        case 'orderFinish':
          await syncFrom99(storeId, orderId, 'completed', 'Concluído no 99Food', {});
          break;
        case 'orderCancelApply':
        case 'orderRefundApply':
        case 'orderPartialCancel':
          await noteOn(storeId, orderId, type === 'orderCancelApply'
            ? `Cliente pediu cancelamento no 99Food: ${String(data?.apply_reason ?? '').slice(0, 150)}. Responda pelo app 99Food Loja em até 5 min (sem resposta, o 99 recusa).`
            : type === 'orderRefundApply'
              ? `Cliente pediu reembolso no 99Food: ${String(data?.apply_reason ?? '').slice(0, 150)}. Responda pelo app 99Food Loja.`
              : 'Parte do pedido foi cancelada no 99Food. Confira no app 99Food Loja.');
          break;
        case 'shopBindStatus': {
          const ids: string[] = (data?.appShopIDList ?? []).map(String);
          const bound = String(data?.bindStatus ?? '') !== 'unbind';
          for (const id of ids) {
            await ensureShop(storeId, id, bound);
            if (bound) shopToken(id, true).catch((e) => req.log.warn({ err: e }, '99food: falha ao buscar token da loja'));
          }
          await logEvent(storeId, type, ids.join(','), null, bound ? 'Loja ligada ao app' : 'Loja desligada do app');
          return ok(reply);
        }
        default:
          break;
      }
      await logEvent(storeId, type, shop, orderId, 'ok');
      return ok(reply);
    } catch (e: any) {
      req.log.error({ err: e }, `99food: falha ao tratar ${type}`);
      await logEvent(storeId, type, shop, orderId, `Erro: ${e?.message ?? e}`);
      return fail(reply, 200, 'processing error');
    }
  });
}

function safeParse(s: string) {
  try {
    return parseJsonBig(s);
  } catch {
    return null;
  }
}

async function ensureShop(storeId: string, appShopId: string, bound = true) {
  await pool.query(
    `INSERT INTO food99_shops (app_shop_id, store_id, bound) VALUES ($1,$2,$3)
     ON CONFLICT (app_shop_id) DO UPDATE SET bound = EXCLUDED.bound, updated_at = now()
       WHERE food99_shops.bound IS DISTINCT FROM EXCLUDED.bound`,
    [appShopId, storeId, bound],
  );
}

async function findOrder(storeId: string, orderId: string | null) {
  if (!orderId) return null;
  const r = await pool.query(`SELECT id, number, status FROM orders WHERE store_id = $1 AND channel = '99food' AND external_id = $2`, [storeId, orderId]);
  return r.rows[0] ?? null;
}

const RANK = ['received', 'confirmed', 'preparing', 'out_for_delivery', 'completed'];

// Mudança feita no 99Food: só avança (nunca volta etapa) e não é enviada de volta ao 99.
async function syncFrom99(storeId: string, orderId: string | null, to: string | null, note: string, flags: Record<string, unknown>) {
  const o = await findOrder(storeId, orderId);
  if (!o) return;
  const changed = await tx(async (db) => {
    if (Object.keys(flags).length) await setExternalFlags(db, o.id, flags);
    if (!to || o.status === 'completed' || o.status === 'cancelled') return false;
    if (to !== 'cancelled' && RANK.indexOf(o.status) >= RANK.indexOf(to)) return false;
    await changeStatus(db, storeId, o.id, to as any, null, note);
    return true;
  });
  if (changed) emitStoreEvent(storeId, { type: 'order.updated', orderId: o.id, number: o.number });
}

async function noteOn(storeId: string, orderId: string | null, note: string) {
  const o = await findOrder(storeId, orderId);
  if (!o) return;
  await pool.query(
    `INSERT INTO order_status_history (order_id, store_id, from_status, to_status, note) VALUES ($1,$2,$3,$3,$4)`,
    [o.id, storeId, o.status, note],
  );
  emitStoreEvent(storeId, { type: 'order.updated', orderId: o.id, number: o.number });
}

export async function autoConfirm(storeId: string, id: string) {
  const o = (await pool.query('SELECT * FROM orders WHERE id = $1', [id])).rows[0];
  if (!o || o.status !== 'received') return;
  try {
    await food99Api.confirm(o.external_shop_id, o.external_id);
  } catch (e: any) {
    await noteOn(storeId, o.external_id, `Aceite automático no 99Food falhou: ${e?.message ?? e}. Clique em Confirmar pedido para tentar de novo (prazo de 5 min).`);
    await logEvent(storeId, 'aceite_automatico', o.external_shop_id, o.external_id, `Falhou: ${e?.message ?? e}`);
    return;
  }
  await tx(async (db) => {
    await setExternalFlags(db, id, { confirmed: true });
    const cur = (await db.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (cur?.status === 'received') await changeStatus(db, storeId, id, 'confirmed', null, 'Aceito automaticamente no 99Food');
  });
  await logEvent(storeId, 'aceite_automatico', o.external_shop_id, o.external_id, 'Aceito');
  emitStoreEvent(storeId, { type: 'order.updated', orderId: id, number: o.number });
}
