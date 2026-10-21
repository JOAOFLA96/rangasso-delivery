import { defineConfig } from 'vitest/config';

// Integração ponta a ponta: API real + PostgreSQL + agente (bundle) + impressora TCP simulada.
export default defineConfig({ test: { include: ['integration/**/*.test.ts'], testTimeout: 90_000, hookTimeout: 120_000, fileParallelism: false } });
