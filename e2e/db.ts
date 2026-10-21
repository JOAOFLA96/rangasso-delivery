import pg from 'pg';

export const db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL ?? 'postgres://rangasso:dev_only_password@localhost:5432/rangasso_dev', max: 2 });

export async function orderCount() {
  return (await db.query('SELECT count(*)::int AS n FROM orders')).rows[0].n as number;
}
