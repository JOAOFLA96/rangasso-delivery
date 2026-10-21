import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { removeImage, saveImage } from '../../lib/uploads.js';
import { requireRole } from '../../auth.js';
import { imageUrl } from '../../services/menu.js';
import { isPromoValid } from '../../services/pricing.js';

const uuid = z.string().uuid();
const cents = z.number().int().min(0).max(100_000_00);

const categoryBody = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(200).default(''),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10000).optional(),
});

const productBody = z
  .object({
    categoryId: uuid,
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).default(''),
    priceCents: cents,
    promoPriceCents: cents.nullable().default(null),
    promoActive: z.boolean().default(false),
    promoStartsAt: z.string().datetime({ offset: true }).nullable().default(null),
    promoEndsAt: z.string().datetime({ offset: true }).nullable().default(null),
    available: z.boolean().default(true),
    active: z.boolean().default(true),
    trackStock: z.boolean().default(false),
    stockQty: z.number().int().min(0).max(100000).nullable().default(null),
    sortOrder: z.number().int().min(0).max(10000).optional(),
  })
  .superRefine((p, ctx) => {
    if (p.promoActive && p.promoPriceCents == null) ctx.addIssue({ code: 'custom', path: ['promoPriceCents'], message: 'Informe o preço promocional.' });
    if (p.promoPriceCents != null && p.promoPriceCents >= p.priceCents) ctx.addIssue({ code: 'custom', path: ['promoPriceCents'], message: 'O preço promocional precisa ser menor que o preço normal.' });
    if (p.promoStartsAt && p.promoEndsAt && new Date(p.promoEndsAt) <= new Date(p.promoStartsAt)) ctx.addIssue({ code: 'custom', path: ['promoEndsAt'], message: 'O fim da promoção precisa ser depois do início.' });
    if (p.trackStock && p.stockQty == null) ctx.addIssue({ code: 'custom', path: ['stockQty'], message: 'Informe a quantidade em estoque.' });
  });

const addonGroupBody = z
  .object({
    name: z.string().trim().min(1).max(60),
    minSelect: z.number().int().min(0).max(20),
    maxSelect: z.number().int().min(1).max(30),
    active: z.boolean().default(true),
    addons: z
      .array(
        z.object({
          id: uuid.optional(),
          name: z.string().trim().min(1).max(60),
          priceCents: cents,
          available: z.boolean().default(true),
        }),
      )
      .max(40),
  })
  .refine((g) => g.maxSelect >= g.minSelect, { path: ['maxSelect'], message: 'Máximo precisa ser maior ou igual ao mínimo.' });

const reorderBody = z.object({ ids: z.array(uuid).min(1).max(500) });

function productDto(p: any) {
  return {
    id: p.id, categoryId: p.category_id, name: p.name, description: p.description, imageUrl: imageUrl(p.image_path),
    priceCents: p.price_cents, promoPriceCents: p.promo_price_cents, promoActive: p.promo_active,
    promoStartsAt: p.promo_starts_at, promoEndsAt: p.promo_ends_at, promoValidNow: isPromoValid(p),
    available: p.available, active: p.active, archived: !!p.archived_at, trackStock: p.track_stock, stockQty: p.stock_qty,
    sortOrder: p.sort_order, updatedAt: p.updated_at,
  };
}

export async function adminMenuRoutes(app: FastifyInstance) {
  const canEdit = { preHandler: requireRole('owner', 'manager') };
  // Disponibilidade e estoque podem ser alterados por qualquer usuário da operação (ex.: "acabou").
  const actor = (req: any) => ({ storeId: req.admin.storeId, userId: req.admin.userId, ip: req.ip });

  app.get('/menu', async (req) => {
    const storeId = req.admin!.storeId;
    const cats = await pool.query('SELECT * FROM categories WHERE store_id = $1 AND archived_at IS NULL ORDER BY sort_order, name', [storeId]);
    const prods = await pool.query('SELECT * FROM products WHERE store_id = $1 AND archived_at IS NULL ORDER BY sort_order, name', [storeId]);
    const groups = await pool.query('SELECT * FROM addon_groups WHERE store_id = $1 AND active ORDER BY sort_order, name', [storeId]);
    const addons = await pool.query('SELECT * FROM addons WHERE store_id = $1 AND active ORDER BY sort_order, name', [storeId]);
    return {
      categories: cats.rows.map((c) => ({ id: c.id, name: c.name, description: c.description, active: c.active, sortOrder: c.sort_order })),
      products: prods.rows.map((p) => ({
        ...productDto(p),
        addonGroups: groups.rows
          .filter((g) => g.product_id === p.id)
          .map((g) => ({
            id: g.id, name: g.name, minSelect: g.min_select, maxSelect: g.max_select, active: g.active,
            addons: addons.rows.filter((a) => a.group_id === g.id).map((a) => ({ id: a.id, name: a.name, priceCents: a.price_cents, available: a.available })),
          })),
      })),
    };
  });

  // Categorias -----------------------------------------------------------------
  app.post('/categories', canEdit, async (req) => {
    const b = parse(categoryBody, req.body);
    const storeId = req.admin!.storeId;
    return tx(async (db) => {
      const r = await db.query(
        `INSERT INTO categories (store_id, name, description, active, sort_order)
         VALUES ($1,$2,$3,$4, COALESCE($5, (SELECT coalesce(max(sort_order),0)+10 FROM categories WHERE store_id = $1))) RETURNING id`,
        [storeId, b.name, b.description, b.active, b.sortOrder ?? null],
      );
      await audit(db, actor(req), 'category.create', 'category', r.rows[0].id, b);
      return { id: r.rows[0].id };
    });
  });

  app.put<{ Params: { id: string } }>('/categories/:id', canEdit, async (req) => {
    const id = parse(uuid, req.params.id);
    const b = parse(categoryBody, req.body);
    return tx(async (db) => {
      const r = await db.query(
        `UPDATE categories SET name=$3, description=$4, active=$5, sort_order=COALESCE($6, sort_order)
          WHERE id=$1 AND store_id=$2 AND archived_at IS NULL`,
        [id, req.admin!.storeId, b.name, b.description, b.active, b.sortOrder ?? null],
      );
      if (!r.rowCount) throw notFound('Categoria');
      await audit(db, actor(req), 'category.update', 'category', id, b);
      return { ok: true };
    });
  });

  app.delete<{ Params: { id: string } }>('/categories/:id', canEdit, async (req) => {
    const id = parse(uuid, req.params.id);
    return tx(async (db) => {
      const used = await db.query('SELECT count(*)::int AS n FROM products WHERE category_id = $1 AND archived_at IS NULL', [id]);
      if (used.rows[0].n > 0) throw badRequest('category_not_empty', 'Mova ou arquive os produtos desta categoria antes de excluí-la.');
      const r = await db.query('UPDATE categories SET archived_at = now(), active = false WHERE id = $1 AND store_id = $2 AND archived_at IS NULL', [id, req.admin!.storeId]);
      if (!r.rowCount) throw notFound('Categoria');
      await audit(db, actor(req), 'category.archive', 'category', id);
      return { ok: true };
    });
  });

  app.post('/categories/reorder', canEdit, async (req) => {
    const b = parse(reorderBody, req.body);
    await tx(async (db) => {
      for (const [i, id] of b.ids.entries()) await db.query('UPDATE categories SET sort_order = $3 WHERE id = $1 AND store_id = $2', [id, req.admin!.storeId, (i + 1) * 10]);
      await audit(db, actor(req), 'category.reorder', 'category', '', { ids: b.ids });
    });
    return { ok: true };
  });

  // Produtos ---------------------------------------------------------------------
  async function assertCategory(db: any, storeId: string, categoryId: string) {
    const c = await db.query('SELECT 1 FROM categories WHERE id = $1 AND store_id = $2 AND archived_at IS NULL', [categoryId, storeId]);
    if (!c.rowCount) throw badRequest('invalid_category', 'Categoria inválida.');
  }

  app.post('/products', canEdit, async (req) => {
    const b = parse(productBody, req.body);
    const storeId = req.admin!.storeId;
    return tx(async (db) => {
      await assertCategory(db, storeId, b.categoryId);
      const r = await db.query(
        `INSERT INTO products (store_id, category_id, name, description, price_cents, promo_price_cents, promo_active, promo_starts_at,
            promo_ends_at, available, active, track_stock, stock_qty, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
            COALESCE($14, (SELECT coalesce(max(sort_order),0)+10 FROM products WHERE category_id = $2))) RETURNING *`,
        [storeId, b.categoryId, b.name, b.description, b.priceCents, b.promoPriceCents, b.promoActive, b.promoStartsAt, b.promoEndsAt,
          b.available, b.active, b.trackStock, b.trackStock ? b.stockQty : null, b.sortOrder ?? null],
      );
      await audit(db, actor(req), 'product.create', 'product', r.rows[0].id, b);
      return productDto(r.rows[0]);
    });
  });

  app.put<{ Params: { id: string } }>('/products/:id', canEdit, async (req) => {
    const id = parse(uuid, req.params.id);
    const b = parse(productBody, req.body);
    const storeId = req.admin!.storeId;
    return tx(async (db) => {
      await assertCategory(db, storeId, b.categoryId);
      const before = await db.query('SELECT price_cents, promo_price_cents, promo_active FROM products WHERE id = $1 AND store_id = $2 AND archived_at IS NULL FOR UPDATE', [id, storeId]);
      if (!before.rows[0]) throw notFound('Produto');
      const r = await db.query(
        `UPDATE products SET category_id=$3, name=$4, description=$5, price_cents=$6, promo_price_cents=$7, promo_active=$8,
            promo_starts_at=$9, promo_ends_at=$10, available=$11, active=$12, track_stock=$13, stock_qty=$14,
            sort_order=COALESCE($15, sort_order), updated_at=now()
          WHERE id=$1 AND store_id=$2 RETURNING *`,
        [id, storeId, b.categoryId, b.name, b.description, b.priceCents, b.promoPriceCents, b.promoActive, b.promoStartsAt, b.promoEndsAt,
          b.available, b.active, b.trackStock, b.trackStock ? b.stockQty : null, b.sortOrder ?? null],
      );
      await audit(db, actor(req), 'product.update', 'product', id, { before: before.rows[0], after: b });
      return productDto(r.rows[0]);
    });
  });

  // Atalho operacional: disponibilidade e estoque (liberado para atendentes).
  app.patch<{ Params: { id: string } }>('/products/:id/availability', async (req) => {
    const id = parse(uuid, req.params.id);
    const b = parse(z.object({ available: z.boolean().optional(), stockQty: z.number().int().min(0).max(100000).optional() }), req.body);
    return tx(async (db) => {
      const r = await db.query(
        `UPDATE products SET available = COALESCE($3, available),
            stock_qty = CASE WHEN track_stock AND $4::int IS NOT NULL THEN $4 ELSE stock_qty END, updated_at = now()
          WHERE id = $1 AND store_id = $2 AND archived_at IS NULL RETURNING *`,
        [id, req.admin!.storeId, b.available ?? null, b.stockQty ?? null],
      );
      if (!r.rows[0]) throw notFound('Produto');
      await audit(db, actor(req), 'product.availability', 'product', id, b);
      return productDto(r.rows[0]);
    });
  });

  // "Excluir" arquiva: some do cardápio e do painel, mas pedidos antigos continuam íntegros.
  app.delete<{ Params: { id: string } }>('/products/:id', canEdit, async (req) => {
    const id = parse(uuid, req.params.id);
    return tx(async (db) => {
      const r = await db.query('UPDATE products SET archived_at = now(), active = false, updated_at = now() WHERE id = $1 AND store_id = $2 AND archived_at IS NULL', [id, req.admin!.storeId]);
      if (!r.rowCount) throw notFound('Produto');
      await audit(db, actor(req), 'product.archive', 'product', id);
      return { ok: true };
    });
  });

  app.post('/products/reorder', canEdit, async (req) => {
    const b = parse(reorderBody, req.body);
    await tx(async (db) => {
      for (const [i, id] of b.ids.entries()) await db.query('UPDATE products SET sort_order = $3 WHERE id = $1 AND store_id = $2', [id, req.admin!.storeId, (i + 1) * 10]);
      await audit(db, actor(req), 'product.reorder', 'product', '', { ids: b.ids });
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/products/:id/image', canEdit, async (req) => {
    const id = parse(uuid, req.params.id);
    const storeId = req.admin!.storeId;
    const p = await pool.query('SELECT image_path FROM products WHERE id = $1 AND store_id = $2 AND archived_at IS NULL', [id, storeId]);
    if (!p.rows[0]) throw notFound('Produto');
    const rel = await saveImage(req, 'products', 900);
    await pool.query('UPDATE products SET image_path = $3, updated_at = now() WHERE id = $1 AND store_id = $2', [id, storeId, rel]);
    await removeImage(p.rows[0].image_path);
    await audit(pool, actor(req), 'product.image', 'product', id);
    return { imageUrl: imageUrl(rel) };
  });

  app.delete<{ Params: { id: string } }>('/products/:id/image', canEdit, async (req) => {
    const id = parse(uuid, req.params.id);
    const p = await pool.query('UPDATE products SET image_path = NULL, updated_at = now() WHERE id = $1 AND store_id = $2 RETURNING (SELECT image_path FROM products WHERE id = $1) AS old', [id, req.admin!.storeId]);
    if (!p.rows[0]) throw notFound('Produto');
    await removeImage(p.rows[0].old);
    return { ok: true };
  });

  // Adicionais -------------------------------------------------------------------
  // O grupo é salvo inteiro; adicionais removidos são desativados (pedidos antigos guardam cópia do nome/preço).
  async function saveGroup(db: any, storeId: string, groupId: string, b: z.infer<typeof addonGroupBody>) {
    const keep: string[] = [];
    for (const [i, a] of b.addons.entries()) {
      if (a.id) {
        const r = await db.query(
          'UPDATE addons SET name=$3, price_cents=$4, available=$5, sort_order=$6, active=true WHERE id=$1 AND group_id=$2 RETURNING id',
          [a.id, groupId, a.name, a.priceCents, a.available, i * 10],
        );
        if (!r.rowCount) throw badRequest('invalid_addon', 'Adicional inválido.');
        keep.push(a.id);
      } else {
        const r = await db.query(
          'INSERT INTO addons (store_id, group_id, name, price_cents, available, sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
          [storeId, groupId, a.name, a.priceCents, a.available, i * 10],
        );
        keep.push(r.rows[0].id);
      }
    }
    await db.query('UPDATE addons SET active = false WHERE group_id = $1 AND NOT (id = ANY($2::uuid[]))', [groupId, keep]);
  }

  app.post<{ Params: { id: string } }>('/products/:id/addon-groups', canEdit, async (req) => {
    const productId = parse(uuid, req.params.id);
    const b = parse(addonGroupBody, req.body);
    const storeId = req.admin!.storeId;
    return tx(async (db) => {
      const p = await db.query('SELECT 1 FROM products WHERE id = $1 AND store_id = $2 AND archived_at IS NULL', [productId, storeId]);
      if (!p.rowCount) throw notFound('Produto');
      const g = await db.query(
        `INSERT INTO addon_groups (store_id, product_id, name, min_select, max_select, active, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,(SELECT coalesce(max(sort_order),0)+10 FROM addon_groups WHERE product_id = $2)) RETURNING id`,
        [storeId, productId, b.name, b.minSelect, b.maxSelect, b.active],
      );
      await saveGroup(db, storeId, g.rows[0].id, b);
      await audit(db, actor(req), 'addon_group.create', 'addon_group', g.rows[0].id, b);
      return { id: g.rows[0].id };
    });
  });

  app.put<{ Params: { id: string } }>('/addon-groups/:id', canEdit, async (req) => {
    const id = parse(uuid, req.params.id);
    const b = parse(addonGroupBody, req.body);
    const storeId = req.admin!.storeId;
    return tx(async (db) => {
      const r = await db.query('UPDATE addon_groups SET name=$3, min_select=$4, max_select=$5, active=$6 WHERE id=$1 AND store_id=$2', [id, storeId, b.name, b.minSelect, b.maxSelect, b.active]);
      if (!r.rowCount) throw notFound('Grupo de adicionais');
      await saveGroup(db, storeId, id, b);
      await audit(db, actor(req), 'addon_group.update', 'addon_group', id, b);
      return { ok: true };
    });
  });

  app.delete<{ Params: { id: string } }>('/addon-groups/:id', canEdit, async (req) => {
    const id = parse(uuid, req.params.id);
    return tx(async (db) => {
      // Desativa em vez de apagar: order_item_addons referencia addons.
      const r = await db.query('UPDATE addon_groups SET active = false WHERE id = $1 AND store_id = $2', [id, req.admin!.storeId]);
      if (!r.rowCount) throw notFound('Grupo de adicionais');
      await audit(db, actor(req), 'addon_group.disable', 'addon_group', id);
      return { ok: true };
    });
  });
}
