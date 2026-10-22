import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatório'),
  // URL pública (ex.: https://delivery.rangasso.com.br). Usada para checagem de origem e links.
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  STORE_SLUG: z.string().default('rangasso'),
  UPLOAD_DIR: z.string().default('./data/uploads'),
  WEB_DIST_DIR: z.string().default('../web/dist'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  // Segredo usado para gerar hash do IP do cliente (anti-abuso sem guardar o IP puro).
  IP_HASH_SECRET: z.string().min(16).default('dev-only-ip-hash-secret-change-me'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  LOG_LEVEL: z.string().default('info'),
  // Limite de pedidos por IP a cada 5 minutos. Operadoras móveis compartilham IP (CGNAT), então não deixar baixo demais.
  ORDER_RATE_LIMIT: z.coerce.number().int().positive().default(30),
  GLOBAL_RATE_LIMIT: z.coerce.number().int().positive().default(300),
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  // Pasta com o agent.cjs e agent-version.json gerados pelo build do agente (atualização automática dos agentes).
  AGENT_BUNDLE_DIR: z.string().default('../agent/build'),
  // Serviço de mapas para achar o endereço do cliente na taxa por km (padrão: Nominatim/OpenStreetMap, gratuito, 1 consulta/s).
  GEOCODER_URL: z.string().url().default('https://nominatim.openstreetmap.org'),
});

// Hospedagens que informam o endereço público sozinhas (Render, Railway): usa se PUBLIC_URL não foi definido.
const env = { ...process.env };
if (!env.PUBLIC_URL) {
  if (env.RENDER_EXTERNAL_URL) env.PUBLIC_URL = env.RENDER_EXTERNAL_URL;
  else if (env.RAILWAY_PUBLIC_DOMAIN) env.PUBLIC_URL = `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
}

const parsed = schema.safeParse(env);
if (!parsed.success) {
  console.error('Configuração inválida:', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  process.exit(1);
}

export const config = parsed.data;
export const isProd = config.NODE_ENV === 'production';

if (isProd && config.IP_HASH_SECRET.startsWith('dev-only')) {
  console.error('IP_HASH_SECRET precisa ser definido em produção.');
  process.exit(1);
}
