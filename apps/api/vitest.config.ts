import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://rangasso:dev_only_password@localhost:5432/rangasso_test',
      UPLOAD_DIR: './data/test-uploads',
      AGENT_BUNDLE_DIR: fileURLToPath(new URL('./test/fixtures/agent-bundle', import.meta.url)),
      STORE_SLUG: 'rangasso',
      WEB_DIST_DIR: './nonexistent',
      ORDER_RATE_LIMIT: '10000',
      LOGIN_RATE_LIMIT: '10000',
    },
  },
});
