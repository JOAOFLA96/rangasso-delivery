import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { removeImage, saveImage } from '../../lib/uploads.js';
import { requireRole } from '../../auth.js';
import { imageUrl } from '../../services/menu.js';
import { getOpenState } from '../../services/store.js';

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
}).refine((b) => b.etaMaxMinutes >= b.etaMinMinutes, { path: ['etaMaxMinutes'], message: 'O tempo máximo precisa ser maior ou igual ao mínimo.' });

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
    receiptFooter: s.receipt_footer, updatedAt: s.updated_at,
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
      neighborhoods: hoods.rows.map((n) => ({ id: n.id, name: n.name, city: n.city, feeCents: n.fee_cents, minOrderCents: n.min_order_cents, active: n.active })),
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
    });
    return { ok: true };
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
        await db.query('UPDATE neighborhoods SET name=$3, city=$4, fee_cents=$5, min_order_cents=$6, active=$7 WHERE id=$1 AND store_id=$2', [id, req.admin!.storeId, b.name, b.city, b.feeCents, b.minOrderCents, b.active]);
      } catch (e: any) {
        if (e.code === '23505') throw badRequest('duplicate_neighborhood', 'Já existe um bairro com esse nome.');
        throw e;
      }
      await audit(db, actor(req), 'neighborhood.update', 'neighborhood', id, { before: before.rows[0], after: b });
      return { ok: true };
    });
  });
}
