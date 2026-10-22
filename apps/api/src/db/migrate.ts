import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

// Aplica migrações SQL versionadas em ordem, cada uma em transação, registrando em schema_migrations.
export async function migrate(log: (msg: string) => void = console.log) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        log(`migração aplicada: ${version}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`falha na migração ${version}: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
