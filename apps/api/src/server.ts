import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { bootstrapAdmin } from './scripts/bootstrap-admin.js';

const app = await buildApp();
await migrate((m) => app.log.info(m));
await bootstrapAdmin(pool, (m) => app.log.info(m));
await app.listen({ port: config.PORT, host: config.HOST });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    app.log.info(`recebido ${sig}, encerrando`);
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
