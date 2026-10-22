import webpush from 'web-push';
import { config } from '../config.js';
import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';

// Avisos no celular do cliente (Web Push). As chaves VAPID são geradas na primeira vez e guardadas no banco.
// No iPhone, só funciona com o cardápio adicionado à Tela de Início (iOS 16.4 ou mais novo).

export interface PushMessage { title: string; body: string; url: string; tag: string; final?: boolean }
export interface PushSub { endpoint: string; keys: { p256dh: string; auth: string } }
type Sender = (sub: PushSub, payload: string) => Promise<void>;

let vapid: { publicKey: string; privateKey: string } | null = null;

export async function vapidKeys(db: Db = pool) {
  if (vapid) return vapid;
  const read = async () => {
    const r = await db.query(`SELECT key, value FROM app_secrets WHERE key IN ('vapid_public', 'vapid_private')`);
    const m = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
    return m.vapid_public && m.vapid_private ? { publicKey: m.vapid_public as string, privateKey: m.vapid_private as string } : null;
  };
  let k = await read();
  if (!k) {
    const g = webpush.generateVAPIDKeys();
    await db.query(`INSERT INTO app_secrets (key, value) VALUES ('vapid_public', $1), ('vapid_private', $2) ON CONFLICT (key) DO NOTHING`, [g.publicKey, g.privateKey]);
    k = await read();
  }
  vapid = k;
  return k!;
}

export function resetVapidCache() {
  vapid = null;
}

const subject = () => (config.PUBLIC_URL.startsWith('https://') ? config.PUBLIC_URL : 'mailto:suporte@rangasso.invalid');

let sender: Sender = async (sub, payload) => {
  const k = await vapidKeys();
  await webpush.sendNotification(sub, payload, { vapidDetails: { subject: subject(), publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 4 * 3600, urgency: 'high' });
};
// Testes trocam o envio por um falso.
export function setPushSender(fn: Sender | null) {
  sender = fn ?? sender;
}

export async function savePushSubscription(db: Db, storeId: string, orderId: string, sub: PushSub) {
  const count = (await db.query('SELECT count(*)::int c FROM push_subscriptions WHERE order_id = $1', [orderId])).rows[0].c;
  if (count >= 5) await db.query('DELETE FROM push_subscriptions WHERE id = (SELECT id FROM push_subscriptions WHERE order_id = $1 ORDER BY created_at LIMIT 1)', [orderId]);
  await db.query(
    `INSERT INTO push_subscriptions (store_id, order_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (order_id, endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [storeId, orderId, sub.endpoint, sub.keys.p256dh, sub.keys.auth],
  );
}

// Qual aviso mandar numa mudança de status (null = nenhum).
export function pushForStatus(number: number, from: string, to: string, token: string): PushMessage | null {
  const url = `/cardapio/pedido/${token}`;
  const tag = `pedido-${number}`;
  if (to === 'out_for_delivery') return { title: `Pedido #${number} saiu para entrega 🛵`, body: 'Já está a caminho. Fique de olho no telefone!', url, tag };
  if (from === 'received' && (to === 'confirmed' || to === 'preparing')) return { title: `Pedido #${number} aceito ✅`, body: 'Recebemos e já estamos preparando seu pedido.', url, tag };
  if (to === 'completed') return { title: `Pedido #${number} entregue`, body: 'Bom apetite! Toque aqui para avaliar seu pedido ⭐', url, tag, final: true };
  if (to === 'cancelled') return { title: `Pedido #${number} cancelado`, body: 'Toque para ver o motivo ou fale com a loja.', url, tag, final: true };
  return null;
}

// Envia para todos os aparelhos que pediram aviso deste pedido. Falhas não afetam o pedido.
export async function notifyOrder(orderId: string, msg: PushMessage) {
  const subs = (await pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE order_id = $1', [orderId])).rows;
  const { final, ...data } = msg;
  const payload = JSON.stringify(data);
  let sent = 0;
  for (const s of subs) {
    try {
      await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      sent++;
    } catch (e: any) {
      // 404/410: o aparelho cancelou a inscrição.
      if (e?.statusCode === 404 || e?.statusCode === 410) await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
    }
  }
  if (final) {
    await pool.query('DELETE FROM push_subscriptions WHERE order_id = $1', [orderId]); // pedido encerrado
  }
  return sent;
}
