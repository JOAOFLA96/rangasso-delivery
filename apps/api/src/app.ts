import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config, isProd } from './config.js';
import { pool } from './db/pool.js';
import { AppError } from './lib/errors.js';
import { uploadRoot } from './lib/uploads.js';
import { registerAdminGuard } from './auth.js';
import { publicRoutes } from './routes/public.js';
import { authRoutes } from './routes/auth.js';
import { agentRoutes } from './routes/agent.js';
import { adminOrderRoutes } from './routes/admin/orders.js';
import { adminMenuRoutes } from './routes/admin/menu.js';
import { adminSettingsRoutes } from './routes/admin/settings.js';
import { adminPrinterRoutes } from './routes/admin/printer.js';
import { adminUserRoutes } from './routes/admin/users.js';

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger === false ? false : {
      level: config.LOG_LEVEL,
      // Não registrar cookies, tokens nem corpo das requisições (dados pessoais).
      redact: ['req.headers.cookie', 'req.headers.authorization'],
    },
    trustProxy: config.TRUST_PROXY === 'true',
    bodyLimit: 256 * 1024,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'", 'https://viacep.com.br'],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: isProd ? [] : null,
      },
    },
    hsts: isProd ? { maxAge: 31536000 } : false,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(multipart);

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if ((err as FastifyError).statusCode === 429) {
      return reply.code(429).send({ error: { code: 'rate_limited', message: 'Muitas requisições. Aguarde um pouco e tente novamente.' } });
    }
    if ((err as FastifyError).statusCode && (err as FastifyError).statusCode! < 500) {
      return reply.code((err as FastifyError).statusCode!).send({ error: { code: 'bad_request', message: 'Requisição inválida.' } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'internal', message: 'Erro interno. Tente novamente.' } });
  });

  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  await app.register(publicRoutes, { prefix: '/api/public' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(agentRoutes, { prefix: '/api/agent' });
  await app.register(
    async (admin) => {
      registerAdminGuard(admin);
      await admin.register(adminOrderRoutes);
      await admin.register(adminMenuRoutes);
      await admin.register(adminSettingsRoutes);
      await admin.register(adminPrinterRoutes);
      await admin.register(adminUserRoutes);
    },
    { prefix: '/api/admin' },
  );

  await mkdir(uploadRoot(), { recursive: true });
  await app.register(fastifyStatic, {
    root: uploadRoot(),
    prefix: '/uploads/',
    decorateReply: false,
    maxAge: '30d',
    immutable: true,
  });

  // Frontend compilado (cardápio + painel). Rotas do SPA caem no index.html.
  const webDist = path.resolve(config.WEB_DIST_DIR);
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: false, index: false });
    app.get('/', (_req, reply) => reply.redirect('/cardapio'));
    const spa = (_req: any, reply: any) => reply.header('cache-control', 'no-cache').sendFile('index.html', webDist);
    app.get('/cardapio', spa);
    app.get('/cardapio/*', spa);
    app.get('/admin', spa);
    app.get('/admin/*', spa);
  }

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'Não encontrado.' } });
  });

  return app;
}
