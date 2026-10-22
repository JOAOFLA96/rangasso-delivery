import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { removeImage, saveImage } from '../../lib/uploads.js';
import { requireRole } from '../../auth.js';
import { imageUrl } from '../../services/menu.js';
import { getOpenState, getSettings } from '../../services/store.js';
import { distanceKm, geocodeAddress, geocodeText, type GeoTry } from '../../services/geocode.js';
import { distanceTiers } from '../../services/orders.js';

const uuid = z.string().uuid();
const cents = z.number().int().min(0).max(100_000_00);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use o formato HH:MM');

const storeBody = z.object({
  displayName: z.string().trim().min(1).max(60),
  tagline: z.string().max(80),
  phone: z.string().max(25),
  whatsapp: z.string().max(25),
  address: z.string().max(200),
  menuMessage: z.string().max(300),
  closedMessage: z.string().max(300),
  deliveryInstructions: z.string().max(400),
  privacyContact: z.string().max(120),
  acceptsCash: z.boolean(),
  acceptsPix: z.boolean(),
  acceptsCard: z.boolean(),
  pixKey: z.string().max(120),
  pixInstructions: z.string().max(300),
}).refine((b) => b.acceptsCash || b.acceptsPix || b.acceptsCard, { path: ['acceptsCash'], message: 'Habilite pelo menos uma forma de pagamento.' });

const deliveryBody = z.object({
  minOrderCents: cents,
  etaMinMinutes: z.number().int().min(0).max(600),
  etaMaxMinutes: z.number().int().min(0).max(600),
  openMode: z.enum(['auto', 'force_open', 'force_closed']),
  acceptUnlistedNeighborhoods: z.boolean().optional(),
}).refine((b) => b.etaMaxMinutes >= b.etaMinMinutes, { path: ['etaMaxMinutes'], message: 'O tempo máximo precisa ser maior ou igual ao mínimo.' });

const distanceBody = z.object({
  mode: z.enum(['neighborhood', 'distance']),
  storeLat: z.number().min(-90).max(90).nullable(),
  storeLng: z.number().min(-180).max(180).nullable(),
  tiers: z.array(z.object({ maxKm: z.number().positive().max(200), feeCents: cents })).max(30),
  // Endereço da loja (o mesmo de "Dados da loja"); opcional para não exigir de quem só troca as faixas.
  address: z.string().trim().max(200).optional(),
}).refine((b) => b.mode !== 'distance' || (b.storeLat != null && b.storeLng != null), { path: ['storeLat'], message: 'Localize a loja antes de ligar a taxa por km.' })
  .refine((b) => b.mode !== 'distance' || b.tiers.length > 0, { path: ['tiers'], message: 'Cadastre pelo menos uma faixa de km.' })
  .refine((b) => new Set(b.tiers.map((t) => Math.round(t.maxKm * 100))).size === b.tiers.length, { path: ['tiers'], message: 'Há duas faixas com o mesmo km.' });

const printerBody = z.object({
  printerModel: z.string().trim().min(1).max(80),
  printerConnection: z.enum(['usb', 'network', 'serial']),
  printerHost: z.string().max(100),
  printerPort: z.number().int().min(1).max(65535),
  printerWindowsName: z.string().max(120),
  autoPrint: z.boolean(),
  printCopies: z.number().int().min(1).max(5),
  paperColumns: z.union([z.literal(32), z.literal(42), z.literal(48)]),
  receiptFooter: z.string().max(200),
});

const neighborhoodBody = z.object({
  name: z.string().trim().min(1).max(80),
  city: z.string().trim().max(80).default(''),
  feeCents: cents,
  minOrderCents: cents.nullable().default(null),
  active: z.boolean().default(true),
});

const hoursBody = z.object({
  shifts: z.array(z.object({ weekday: z.number().int().min(0).max(6), opensAt: hhmm, closesAt: hhmm })).max(28),
});

export function settingsDto(s: any) {
  return {
    displayName: s.display_name, tagline: s.tagline, logoUrl: imageUrl(s.logo_path), phone: s.phone, whatsapp: s.whatsapp,
    address: s.address, menuMessage: s.menu_message, closedMessage: s.closed_message, deliveryInstructions: s.delivery_instructions,
    privacyContact: s.privacy_contact, timezone: s.timezone, minOrderCents: s.min_order_cents, etaMinMinutes: s.eta_min_minutes,
    etaMaxMinutes: s.eta_max_minutes, acceptsCash: s.accepts_cash, acceptsPix: s.accepts_pix, acceptsCard: s.accepts_card,
    pixKey: s.pix_key, pixInstructions: s.pix_instructions, openMode: s.open_mode, printerModel: s.printer_model,
    printerConnection: s.printer_connection, printerHost: s.printer_host, printerPort: s.printer_port,
    printerWindowsName: s.printer_windows_name, autoPrint: s.auto_print, printCopies: s.print_copies, paperColumns: s.paper_columns,
    receiptFooter: s.receipt_footer, acceptUnlistedNeighborhoods: s.accept_unlisted_neighborhoods, updatedAt: s.updated_at,
  };
}

export async function adminSettingsRoutes(app: FastifyInstance) {
  const canEdit = { preHandler: requireRole('owner', 'manager') };
  const actor = (req: any) => ({ storeId: req.admin.storeId, userId: req.admin.userId, ip: req.ip });

  app.get('/settings', async (req) => {
    const storeId = req.admin!.storeId;
    const s = (await pool.query('SELECT * FROM store_settings WHERE store_id = $1', [storeId])).rows[0];
    const hours = await pool.query(
      `SELECT weekday, to_char(opens_at,'HH24:MI') AS "opensAt", to_char(closes_at,'HH24:MI') AS "closesAt"
         FROM opening_hours WHERE store_id = $1 ORDER BY weekday, opens_at`,
      [storeId],
    );
    const closures = await pool.query(
      `SELECT id, to_char(date,'YYYY-MM-DD') AS date, reason FROM store_closures WHERE store_id = $1 AND date >= current_date - 1 ORDER BY date`,
      [storeId],
    );
    const hoods = await pool.query('SELECT * FROM neighborhoods WHERE store_id = $1 ORDER BY active DESC, sort_order, name', [storeId]);
    return {
      settings: settingsDto(s),
      openState: await getOpenState(pool, storeId, s),
      hours: hours.rows,
      closures: closures.rows,
      neighborhoods: hoods.rows.map((n) => ({ id: n.id, name: n.name, city: n.city, feeCents: n.fee_cents, minOrderCents: n.min_order_cents, active: n.active, feePending: n.fee_pending })),
      distance: { mode: s.delivery_fee_mode, storeLat: s.store_lat, storeLng: s.store_lng, tiers: await distanceTiers(pool, storeId) },
    };
  });

  async function updateSettings(req: any, section: string, sets: Record<string, unknown>) {
    const cols = Object.keys(sets);
    const vals = Object.values(sets);
    await tx(async (db) => {
      const before = (await db.query(`SELECT ${cols.join(', ')} FROM store_settings WHERE store_id = $1 FOR UPDATE`, [req.admin.storeId])).rows[0];
      await db.query(
        `UPDATE store_settings SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE store_id = $1`,
        [req.admin.storeId, ...vals],
      );
      await audit(db, actor(req), `settings.${section}`, 'store_settings', req.admin.storeId, { before, after: sets });
    });
  }

  app.put('/settings/store', canEdit, async (req) => {
    const b = parse(storeBody, req.body);
    await updateSettings(req, 'store', {
      display_name: b.displayName, tagline: b.tagline, phone: b.phone, whatsapp: b.whatsapp, address: b.address,
      menu_message: b.menuMessage, closed_message: b.closedMessage, delivery_instructions: b.deliveryInstructions,
      privacy_contact: b.privacyContact, accepts_cash: b.acceptsCash, accepts_pix: b.acceptsPix, accepts_card: b.acceptsCard,
      pix_key: b.pixKey, pix_instructions: b.pixInstructions,
    });
    return { ok: true };
  });

  app.put('/settings/delivery', canEdit, async (req) => {
    const b = parse(deliveryBody, req.body);
    await updateSettings(req, 'delivery', {
      min_order_cents: b.minOrderCents, eta_min_minutes: b.etaMinMinutes, eta_max_minutes: b.etaMaxMinutes, open_mode: b.openMode,
      ...(b.acceptUnlistedNeighborhoods === undefined ? {} : { accept_unlisted_neighborhoods: b.acceptUnlistedNeighborhoods }),
    });
    return { ok: true };
  });

  // Taxa por km: localização da loja + faixas. As faixas são trocadas todas de uma vez.
  app.put('/settings/distance', canEdit, async (req) => {
    const b = parse(distanceBody, req.body);
    const storeId = (req as any).admin.storeId;
    await tx(async (db) => {
      const before = (await db.query('SELECT delivery_fee_mode, store_lat, store_lng FROM store_settings WHERE store_id = $1 FOR UPDATE', [storeId])).rows[0];
      const beforeTiers = await distanceTiers(db, storeId);
      await db.query('UPDATE store_settings SET delivery_fee_mode = $2, store_lat = $3, store_lng = $4, updated_at = now() WHERE store_id = $1', [storeId, b.mode, b.storeLat, b.storeLng]);
      if (b.address) await db.query('UPDATE store_settings SET address = $2 WHERE store_id = $1', [storeId, b.address]);
      await db.query('DELETE FROM delivery_distance_tiers WHERE store_id = $1', [storeId]);
      for (const t of b.tiers) {
        await db.query('INSERT INTO delivery_distance_tiers (store_id, max_km, fee_cents) VALUES ($1,$2,$3)', [storeId, Math.round(t.maxKm * 100) / 100, t.feeCents]);
      }
      await audit(db, actor(req), 'settings.distance', 'store_settings', storeId, { before: { ...before, tiers: beforeTiers }, after: b });
    });
    return { ok: true };
  });

  // Acha a localização da loja pelo endereço (serviço de mapas). Não grava: o painel mostra e o gerente confirma.
  app.post('/settings/locate-store', canEdit, async (req) => {
    const b = parse(z.object({ address: z.string().trim().min(5).max(200) }), req.body);
    const p = await geocodeText(pool, b.address);
    if (!p) throw badRequest('not_found', 'Não achei esse endereço no mapa. Confira o texto ou informe a latitude e longitude manualmente.');
    return { lat: p.lat, lng: p.lng, precision: p.precision, label: p.label };
  });

  // Teste de um endereço de cliente: mostra o que cada serviço de mapas achou, a distância e a taxa que o pedido teria.
  app.post('/settings/test-address', canEdit, async (req) => {
    const b = parse(z.object({
      street: z.string().trim().min(2).max(120), number: z.string().trim().max(15).default(''), city: z.string().trim().min(2).max(80),
      state: z.string().trim().max(30).default(''), cep: z.string().max(12).default(''),
    }), req.body);
    const storeId = (req as any).admin.storeId;
    const s = await getSettings(pool, storeId);
    const trace: GeoTry[] = [];
    const p = await geocodeAddress(pool, b, trace);
    const tiers = await distanceTiers(pool, storeId);
    const km = p && s.store_lat != null && s.store_lng != null ? Math.round(distanceKm({ lat: s.store_lat, lng: s.store_lng }, p) * 100) / 100 : null;
    const tier = km == null ? null : tiers.find((t) => km <= t.maxKm) ?? null;
    return {
      found: p ? { lat: p.lat, lng: p.lng, label: p.label, precision: p.precision, provider: p.provider } : null,
      distanceKm: km, feeCents: tier?.feeCents ?? null, outOfArea: km != null && !tier, storeLocated: s.store_lat != null, trace,
    };
  });

  app.put('/settings/printer', canEdit, async (req) => {
    const b = parse(printerBody, req.body);
    if (b.printerConnection === 'network' && !b.printerHost.trim()) throw badRequest('validation_error', 'Informe o IP da impressora.', { fields: [{ field: 'printerHost', message: 'Obrigatório para conexão de rede.' }] });
    await updateSettings(req, 'printer', {
      printer_model: b.printerModel, printer_connection: b.printerConnection, printer_host: b.printerHost.trim(),
      printer_port: b.printerPort, printer_windows_name: b.printerWindowsName.trim(), auto_print: b.autoPrint,
      print_copies: b.printCopies, paper_columns: b.paperColumns, receipt_footer: b.receiptFooter,
    });
    return { ok: true };
  });

  app.post('/settings/logo', canEdit, async (req) => {
    const storeId = req.admin!.storeId;
    const old = (await pool.query('SELECT logo_path FROM store_settings WHERE store_id = $1', [storeId])).rows[0];
    const rel = await saveImage(req, 'store', 600);
    await pool.query('UPDATE store_settings SET logo_path = $2, updated_at = now() WHERE store_id = $1', [storeId, rel]);
    await removeImage(old?.logo_path ?? null);
    await audit(pool, actor(req), 'settings.logo', 'store_settings', storeId);
    return { logoUrl: imageUrl(rel) };
  });

  app.put('/settings/hours', canEdit, async (req) => {
    const b = parse(hoursBody, req.body);
    for (const s of b.shifts) if (s.opensAt === s.closesAt) throw badRequest('validation_error', 'Abertura e fechamento não podem ser iguais.');
    await tx(async (db) => {
      await db.query('DELETE FROM opening_hours WHERE store_id = $1', [req.admin!.storeId]);
      for (const s of b.shifts) {
        await db.query('INSERT INTO opening_hours (store_id, weekday, opens_at, closes_at) VALUES ($1,$2,$3,$4)', [req.admin!.storeId, s.weekday, s.opensAt, s.closesAt]);
      }
      await audit(db, actor(req), 'settings.hours', 'opening_hours', '', b);
    });
    return { ok: true };
  });

  app.post('/closures', canEdit, async (req) => {
    const b = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().max(120).default('') }), req.body);
    return tx(async (db) => {
      const r = await db.query(
        `INSERT INTO store_closures (store_id, date, reason) VALUES ($1,$2,$3)
         ON CONFLICT (store_id, date) DO UPDATE SET reason = EXCLUDED.reason RETURNING id`,
        [req.admin!.storeId, b.date, b.reason],
      );
      await audit(db, actor(req), 'closure.upsert', 'store_closure', r.rows[0].id, b);
      return { id: r.rows[0].id };
    });
  });

  app.delete<{ Params: { id: string } }>('/closures/:id', canEdit, async (req) => {
    const id = parse(uuid, req.params.id);
    return tx(async (db) => {
      const r = await db.query('DELETE FROM store_closures WHERE id = $1 AND store_id = $2 RETURNING date', [id, req.admin!.storeId]);
      if (!r.rowCount) throw notFound('Exceção');
      await audit(db, actor(req), 'closure.delete', 'store_closure', id);
      return { ok: true };
    });
  });

  // Bairros -----------------------------------------------------------------------
  app.post('/neighborhoods', canEdit, async (req) => {
    const b = parse(neighborhoodBody, req.body);
    return tx(async (db) => {
      try {
        const r = await db.query(
          `INSERT INTO neighborhoods (store_id, name, city, fee_cents, min_order_cents, active, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,(SELECT coalesce(max(sort_order),0)+10 FROM neighborhoods WHERE store_id = $1)) RETURNING id`,
          [req.admin!.storeId, b.name, b.city, b.feeCents, b.minOrderCents, b.active],
        );
        await audit(db, actor(req), 'neighborhood.create', 'neighborhood', r.rows[0].id, b);
        return { id: r.rows[0].id };
      } catch (e: any) {
        if (e.code === '23505') throw badRequest('duplicate_neighborhood', 'Já existe um bairro com esse nome.');
        throw e;
      }
    });
  });

  app.put<{ Params: { id: string } }>('/neighborhoods/:id', canEdit, async (req) => {
    const id = parse(uuid, req.params.id);
    const b = parse(neighborhoodBody, req.body);
    return tx(async (db) => {
      const before = await db.query('SELECT name, fee_cents, min_order_cents, active FROM neighborhoods WHERE id = $1 AND store_id = $2', [id, req.admin!.storeId]);
      if (!before.rows[0]) throw notFound('Bairro');
      try {
        await db.query('UPDATE neighborhoods SET name=$3, city=$4, fee_cents=$5, min_order_cents=$6, active=$7, fee_pending=false WHERE id=$1 AND store_id=$2', [id, req.admin!.storeId, b.name, b.city, b.feeCents, b.minOrderCents, b.active]);
      } catch (e: any) {
        if (e.code === '23505') throw badRequest('duplicate_neighborhood', 'Já existe um bairro com esse nome.');
        throw e;
      }
      await audit(db, actor(req), 'neighborhood.update', 'neighborhood', id, { before: before.rows[0], after: b });
      return { ok: true };
    });
  });
}
