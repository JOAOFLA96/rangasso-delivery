import pg from 'pg';
import { config } from '../config.js';

// Retorna bigint/numeric como string por padrão; contagens são convertidas onde usadas.
export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });

export type Db = pg.Pool | pg.PoolClient;

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
