// LGPD: anonimiza dados pessoais de pedidos antigos, mantendo valores e itens para o histórico financeiro.
// Uso: npm run anonymize -- --days 365
import { parseArgs } from 'node:util';
import { pool } from '../db/pool.js';

const { values } = parseArgs({ options: { days: { type: 'string', default: '365' }, 'dry-run': { type: 'boolean', default: false } } });
const days = Number(values.days);
if (!Number.isInteger(days) || days < 30) {
  console.error('--days precisa ser inteiro >= 30');
  process.exit(1);
}
const where = `anonymized_at IS NULL AND status IN ('completed','cancelled') AND created_at < now() - make_interval(days => $1)`;
if (values['dry-run']) {
  const r = await pool.query(`SELECT count(*)::int AS n FROM orders WHERE ${where}`, [days]);
  console.log(`${r.rows[0].n} pedido(s) seriam anonimizados.`);
} else {
  const r = await pool.query(
    `UPDATE orders SET customer_name = 'Anonimizado', customer_phone = '', cep = '', street = '-', street_number = '-', complement = '',
        reference = '', notes = '', customer_ip_hash = NULL, anonymized_at = now()
      WHERE ${where}`,
    [days],
  );
  await pool.query(`UPDATE print_jobs SET payload = '{"anonymized":true}'::jsonb WHERE order_id IN (SELECT id FROM orders WHERE anonymized_at IS NOT NULL) AND payload ? 'order'`);
  console.log(`${r.rowCount} pedido(s) anonimizados.`);
}
await pool.end();
