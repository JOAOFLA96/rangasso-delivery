// Dados de DEMONSTRAÇÃO para desenvolvimento/homologação. Não usar em produção.
// Os produtos são exemplos genéricos marcados como teste; o cardápio real é cadastrado pelo painel.
import { pool, tx } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { config } from '../config.js';
import { ensureStore } from './ensure-store.js';

if (config.NODE_ENV === 'production') {
  console.error('seed-demo não roda em produção.');
  process.exit(1);
}
await migrate(() => {});
await tx(async (db) => {
  const storeId = await ensureStore(db);
  const has = await db.query('SELECT 1 FROM categories WHERE store_id = $1 LIMIT 1', [storeId]);
  if (has.rowCount) {
    console.log('Cardápio já tem dados; nada feito.');
    return;
  }
  await db.query(`UPDATE store_settings SET menu_message = '[TESTE] Cardápio de demonstração', phone = '(00) 00000-0000', open_mode = 'force_open' WHERE store_id = $1`, [storeId]);
  for (let wd = 0; wd < 7; wd++) await db.query(`INSERT INTO opening_hours (store_id, weekday, opens_at, closes_at) VALUES ($1,$2,'18:00','23:30')`, [storeId, wd]);
  const cat = async (name: string, order: number) =>
    (await db.query('INSERT INTO categories (store_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id', [storeId, name, order])).rows[0].id;
  const prod = async (catId: string, name: string, desc: string, price: number, extra: Record<string, unknown> = {}) =>
    (await db.query(
      `INSERT INTO products (store_id, category_id, name, description, price_cents, promo_price_cents, promo_active, available, track_stock, stock_qty, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [storeId, catId, name, desc, price, extra.promo ?? null, !!extra.promo, extra.available ?? true, !!extra.stock, extra.stock ?? null, extra.order ?? 0],
    )).rows[0].id;
  const lanches = await cat('[TESTE] Lanches', 10);
  const porcoes = await cat('[TESTE] Porções', 20);
  const bebidas = await cat('[TESTE] Bebidas', 30);
  const burger = await prod(lanches, 'Burger da Casa (teste)', 'Pão, blend 160 g, queijo e molho da casa.', 3290, { order: 10 });
  await prod(lanches, 'Burger Duplo (teste)', 'Dois blends de 160 g, cheddar e bacon.', 4290, { promo: 3890, order: 20 });
  await prod(lanches, 'Lanche esgotado (teste)', 'Exemplo de produto indisponível.', 2500, { available: false, order: 30 });
  await prod(porcoes, 'Batata frita (teste)', 'Porção de 400 g.', 2900, { order: 10 });
  await prod(bebidas, 'Refrigerante lata (teste)', '350 ml.', 700, { stock: 24, order: 10 });
  const g1 = (await db.query(`INSERT INTO addon_groups (store_id, product_id, name, min_select, max_select, sort_order) VALUES ($1,$2,'Ponto da carne',1,1,10) RETURNING id`, [storeId, burger])).rows[0].id;
  for (const [i, n] of ['Mal passado', 'Ao ponto', 'Bem passado'].entries()) await db.query('INSERT INTO addons (store_id, group_id, name, price_cents, sort_order) VALUES ($1,$2,$3,0,$4)', [storeId, g1, n, i]);
  const g2 = (await db.query(`INSERT INTO addon_groups (store_id, product_id, name, min_select, max_select, sort_order) VALUES ($1,$2,'Adicionais',0,3,20) RETURNING id`, [storeId, burger])).rows[0].id;
  for (const [i, [n, p]] of ([['Bacon', 500], ['Ovo', 300], ['Cheddar extra', 400]] as const).entries()) await db.query('INSERT INTO addons (store_id, group_id, name, price_cents, sort_order) VALUES ($1,$2,$3,$4,$5)', [storeId, g2, n, p, i]);
  for (const [n, fee] of [['Bairro Teste A', 500], ['Bairro Teste B', 800]] as const) await db.query('INSERT INTO neighborhoods (store_id, name, fee_cents) VALUES ($1,$2,$3)', [storeId, n, fee]);
  await db.query(`INSERT INTO neighborhoods (store_id, name, fee_cents, active) VALUES ($1,'Bairro Não Atendido (teste)',0,false)`, [storeId]);
  console.log('Dados de demonstração criados.');
});
await pool.end();
