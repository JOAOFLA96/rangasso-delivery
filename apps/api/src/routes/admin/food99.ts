import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { pool } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { requireRole } from '../../auth.js';
import { Food99Error, food99Api, food99Enabled, shopToken } from '../../services/food99.js';

const webhookUrl = () => `${config.PUBLIC_URL.replace(/\/$/, '')}/api/integrations/99food/webhook`;

function explain(e: unknown) {
  if (e instanceof Food99Error) return new AppError(502, 'food99_refused', `O 99Food respondeu: ${e.message}${e.errno > 0 ? ` (código ${e.errno})` : ''}`);
  return e;
}

// Tela Configurações › 99Food: situação da integração, lojas ligadas e link para a loja autorizar o app.
export async function adminFood99Routes(app: FastifyInstance) {
  app.get('/integrations/99food', async (req) => {
    const storeId = req.admin!.storeId;
    const shops = await pool.query(
      `SELECT app_shop_id, bound, token_expires_at, last_error, updated_at,
              (auth_token IS NOT NULL AND token_expires_at > now()) AS token_ok
         FROM food99_shops WHERE store_id = $1 ORDER BY created_at`,
      [storeId],
    );
    const events = await pool.query(
      `SELECT type, app_shop_id, order_id, result, created_at FROM food99_events
        WHERE store_id = $1 OR store_id IS NULL ORDER BY created_at DESC LIMIT 20`,
      [storeId],
    );
    const counts = await pool.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last24h
         FROM orders WHERE store_id = $1 AND channel = '99food'`,
      [storeId],
    );
    return {
      configured: food99Enabled(),
      appId: config.FOOD99_APP_ID || null,
      autoConfirm: config.FOOD99_AUTO_CONFIRM === 'true',
      webhookUrl: webhookUrl(),
      shops: shops.rows.map((s) => ({
        appShopId: s.app_shop_id, bound: s.bound, tokenOk: s.token_ok, tokenExpiresAt: s.token_expires_at, lastError: s.last_error, updatedAt: s.updated_at,
      })),
      events: events.rows.map((e) => ({ type: e.type, appShopId: e.app_shop_id, orderId: e.order_id, result: e.result, at: e.created_at })),
      orders: counts.rows[0],
    };
  });

  // Link (vale 7 dias) para o SuperAdmin da loja no 99Food autorizar este app.
  app.post('/integrations/99food/bind-link', { preHandler: requireRole('owner', 'manager') }, async (req) => {
    if (!food99Enabled()) throw new AppError(409, 'food99_disabled', 'Coloque FOOD99_APP_ID e FOOD99_APP_SECRET no servidor primeiro.');
    try {
      const url = await food99Api.bindUrl();
      await audit(pool, { storeId: req.admin!.storeId, userId: req.admin!.userId, ip: req.ip }, 'food99.bind_link');
      return { url };
    } catch (e) {
      throw explain(e);
    }
  });

  // Loja ligada pela equipe do 99 (modo assistido): informa o app_shop_id combinado e testa o token.
  app.post('/integrations/99food/shops', { preHandler: requireRole('owner', 'manager') }, async (req) => {
    if (!food99Enabled()) throw new AppError(409, 'food99_disabled', 'Coloque FOOD99_APP_ID e FOOD99_APP_SECRET no servidor primeiro.');
    const b = parse(z.object({ appShopId: z.string().trim().min(1).max(80).regex(/^\S+$/, 'Sem espaços') }), req.body);
    const storeId = req.admin!.storeId;
    await pool.query(
      `INSERT INTO food99_shops (app_shop_id, store_id) VALUES ($1,$2) ON CONFLICT (app_shop_id) DO UPDATE SET bound = true, updated_at = now()`,
      [b.appShopId, storeId],
    );
    await audit(pool, { storeId, userId: req.admin!.userId, ip: req.ip }, 'food99.shop_add', 'food99_shop', b.appShopId);
    try {
      await shopToken(b.appShopId, true);
    } catch (e) {
      throw explain(e);
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/integrations/99food/shops/:id/token', { preHandler: requireRole('owner', 'manager') }, async (req) => {
    const r = await pool.query('SELECT 1 FROM food99_shops WHERE app_shop_id = $1 AND store_id = $2', [req.params.id, req.admin!.storeId]);
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Loja não encontrada.');
    try {
      await shopToken(req.params.id, true);
    } catch (e) {
      throw explain(e);
    }
    return { ok: true };
  });
}
