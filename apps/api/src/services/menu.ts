import type { Db } from '../db/pool.js';
import { effectivePrice, isPromoValid } from './pricing.js';

export const imageUrl = (p: string | null) => (p ? `/uploads/${p}` : null);

// Cardápio público: somente categorias/produtos ativos e não arquivados. Indisponíveis aparecem marcados.
export async function publicMenu(db: Db, storeId: string, now = new Date()) {
  const cats = await db.query(
    `SELECT id, name, description FROM categories
      WHERE store_id = $1 AND active AND archived_at IS NULL ORDER BY sort_order, name`,
    [storeId],
  );
  const prods = await db.query(
    `SELECT p.* FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.store_id = $1 AND p.active AND p.archived_at IS NULL AND c.active AND c.archived_at IS NULL
      ORDER BY p.sort_order, p.name`,
    [storeId],
  );
  const groups = await db.query(
    `SELECT g.* FROM addon_groups g JOIN products p ON p.id = g.product_id
      WHERE g.store_id = $1 AND g.active AND p.active AND p.archived_at IS NULL ORDER BY g.sort_order, g.name`,
    [storeId],
  );
  const addons = await db.query(
    `SELECT a.* FROM addons a JOIN addon_groups g ON g.id = a.group_id
      WHERE a.store_id = $1 AND a.active AND g.active ORDER BY a.sort_order, a.name`,
    [storeId],
  );

  const addonsByGroup = new Map<string, any[]>();
  for (const a of addons.rows) {
    const list = addonsByGroup.get(a.group_id) ?? [];
    list.push({ id: a.id, name: a.name, priceCents: a.price_cents, available: a.available });
    addonsByGroup.set(a.group_id, list);
  }
  const groupsByProduct = new Map<string, any[]>();
  for (const g of groups.rows) {
    const list = groupsByProduct.get(g.product_id) ?? [];
    list.push({ id: g.id, name: g.name, minSelect: g.min_select, maxSelect: g.max_select, addons: addonsByGroup.get(g.id) ?? [] });
    groupsByProduct.set(g.product_id, list);
  }

  return cats.rows
    .map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      products: prods.rows
        .filter((p) => p.category_id === c.id)
        .map((p) => {
          const outOfStock = p.track_stock && (p.stock_qty ?? 0) <= 0;
          return {
            id: p.id,
            name: p.name,
            description: p.description,
            imageUrl: imageUrl(p.image_path),
            priceCents: p.price_cents,
            effectivePriceCents: effectivePrice(p, now),
            promo: isPromoValid(p, now) ? { priceCents: p.promo_price_cents, endsAt: p.promo_ends_at } : null,
            available: p.available && !outOfStock,
            stockLeft: p.track_stock ? p.stock_qty : null,
            addonGroups: groupsByProduct.get(p.id) ?? [],
          };
        }),
    }))
    .filter((c) => c.products.length > 0);
}
