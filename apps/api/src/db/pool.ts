import pg from 'pg';
import { config } from '../config.js';

// Retorna bigint/numeric como string por padrão; contagens são convertidas onde usadas.
export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 30_000 });

// Bancos que "adormecem" (Neon grátis) ou reiniciam derrubam conexões paradas no pool. Sem este tratamento,
// o erro de uma conexão ociosa derruba o servidor inteiro; com ele, a conexão é descartada e a próxima consulta abre outra.
pool.on('error', (err) => {
  console.error(`conexão ociosa com o banco encerrada: ${err.message}`);
});

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
