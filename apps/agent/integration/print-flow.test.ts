import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import iconv from 'iconv-lite';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeNetworkPrinter } from '../test/fakePrinter.js';

// Fluxo completo: cliente faz o pedido na API real → painel → agente (build/agent.cjs) → impressora TCP simulada.
// Precisa de um PostgreSQL com um banco DESCARTÁVEL (nome terminando em _integ ou _test): o schema é recriado.
//   INTEGRATION_DATABASE_URL=postgres://usuario:senha@localhost:5432/rangasso_integ npm -w apps/agent run test:integration

const DB_URL = process.env.INTEGRATION_DATABASE_URL ?? 'postgres://rangasso:dev_only_password@localhost:5432/rangasso_integ';
const PORT = Number(process.env.INTEGRATION_PORT ?? 3199);
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const apiDir = path.join(root, 'apps/api');
const agentBundle = path.join(root, 'apps/agent/build/agent.cjs');
const ADMIN = { email: 'integracao@teste.local', password: 'integracao-senha-123' };

const db = new pg.Pool({ connectionString: DB_URL, max: 2 });
const printer = new FakeNetworkPrinter();
const work = mkdtempSync(path.join(tmpdir(), 'rg-integ-'));
let api: ChildProcess | null = null;
let agent: ChildProcess | null = null;
let agentLog = '';
let cookie = '';
let token = '';
let fixture: { hoodId: string; burgerId: string; pontoId: string; baconId: string };

const apiEnv = {
  ...process.env, NODE_ENV: 'development', DATABASE_URL: DB_URL, PORT: String(PORT), HOST: '127.0.0.1', PUBLIC_URL: BASE,
  UPLOAD_DIR: path.join(work, 'uploads'), ORDER_RATE_LIMIT: '10000', LOGIN_RATE_LIMIT: '10000', GLOBAL_RATE_LIMIT: '100000', LOG_LEVEL: 'warn',
};
const tsx = ['--import', 'tsx'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 20_000, what = 'condição'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`Tempo esgotado esperando: ${what}\n--- log do agente ---\n${agentLog.slice(-3000)}`);
    await sleep(150);
  }
}

async function startApi() {
  api = spawn(process.execPath, [...tsx, 'src/server.ts'], { cwd: apiDir, env: apiEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  api.stderr!.on('data', (d) => process.env.DEBUG_INTEG && process.stderr.write(d));
  await waitFor(() => fetch(`${BASE}/api/public/store`).then((r) => r.ok), 30_000, 'API subir');
}
async function stopApi() {
  if (!api) return;
  const p = api;
  api = null;
  p.kill('SIGTERM');
  await new Promise((r) => p.once('exit', r));
}
function startAgent() {
  agent = spawn(process.execPath, [agentBundle, 'run', '--config', path.join(work, 'config.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
  agent.stdout!.on('data', (d) => (agentLog += d));
  agent.stderr!.on('data', (d) => (agentLog += d));
}
async function stopAgent(signal: NodeJS.Signals = 'SIGTERM') {
  if (!agent) return;
  const p = agent;
  agent = null;
  p.kill(signal);
  await new Promise((r) => p.once('exit', r));
}

async function adminFetch(pathname: string, body?: unknown) {
  const r = await fetch(`${BASE}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, 'x-requested-with': 'rangasso', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: any = await r.json();
  if (!r.ok) throw new Error(`${pathname}: ${r.status} ${JSON.stringify(data)}`);
  return data;
}

async function placeOrder(key = randomUUID()) {
  const r = await fetch(`${BASE}/api/public/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'rangasso' },
    body: JSON.stringify({
      idempotencyKey: key,
      customer: { name: 'João da Integração', phone: '(11) 98765-4321' },
      address: { cep: '01001-000', street: 'Rua São Bento', number: '10', neighborhoodId: fixture.hoodId, complement: '', reference: 'Próximo à praça' },
      notes: 'Sem cebola',
      payment: { method: 'pix', changeForCents: null },
      items: [{ productId: fixture.burgerId, quantity: 1, notes: '', addonIds: [fixture.pontoId, fixture.baconId] }],
      acceptPrivacy: true,
    }),
  });
  const data: any = await r.json();
  if (r.status >= 300) throw new Error(`pedido: ${r.status} ${JSON.stringify(data)}`);
  const id = (await db.query('SELECT id FROM orders WHERE number = $1', [data.number])).rows[0].id as string;
  return { ...data, id } as { number: number; id: string; duplicate: boolean };
}

const printStatus = async (orderId: string) => (await db.query('SELECT print_status FROM orders WHERE id = $1', [orderId])).rows[0].print_status as string;
const jobsOf = async (orderId: string) => (await db.query('SELECT id, kind, status, attempts, last_error FROM print_jobs WHERE order_id = $1 ORDER BY created_at', [orderId])).rows;
// Quantas comandas deste pedido chegaram à impressora (conta o cabeçalho "PEDIDO #n").
const ticketsFor = (n: number) => iconv.decode(Buffer.concat(printer.received), 'cp860').split(`PEDIDO #${n}`).length - 1;
const allText = () => iconv.decode(Buffer.concat(printer.received), 'cp860');

beforeAll(async () => {
  const dbName = new URL(DB_URL).pathname.slice(1);
  if (!/_(integ|test)$/.test(dbName)) throw new Error(`Banco "${dbName}" não parece descartável (precisa terminar em _integ ou _test).`);
  if (!existsSync(agentBundle)) throw new Error('Rode "npm -w apps/agent run build" antes da integração.');
  // Garante o banco (se o usuário puder criar) e zera o schema.
  const admin = new pg.Client({ connectionString: DB_URL.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect().then(async () => {
    const has = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!has.rowCount) await admin.query(`CREATE DATABASE "${dbName}"`);
  }).catch(() => {}).finally(() => admin.end().catch(() => {}));
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  const env = { ...apiEnv, ADMIN_PASSWORD: ADMIN.password };
  execFileSync(process.execPath, [...tsx, 'src/scripts/seed-demo.ts'], { cwd: apiDir, env, stdio: 'pipe' });
  execFileSync(process.execPath, [...tsx, 'src/scripts/create-admin.ts', '--email', ADMIN.email, '--name', 'Integração'], { cwd: apiDir, env, stdio: 'pipe' });

  const q = async (sql: string) => (await db.query(sql)).rows[0].id as string;
  fixture = {
    hoodId: await q(`SELECT id FROM neighborhoods WHERE active ORDER BY name LIMIT 1`),
    burgerId: await q(`SELECT id FROM products WHERE name LIKE 'Burger da Casa%'`),
    pontoId: await q(`SELECT a.id FROM addons a WHERE a.name = 'Ao ponto'`),
    baconId: await q(`SELECT a.id FROM addons a WHERE a.name = 'Bacon'`),
  };
  await db.query(`UPDATE store_settings SET open_mode = 'force_open', min_order_cents = 0`);

  await printer.start();
  // Impressora definida no painel (rede); o agente usa modo "auto".
  await db.query(`UPDATE store_settings SET printer_connection = 'network', printer_host = '127.0.0.1', printer_port = $1, paper_columns = 48, print_copies = 1`, [printer.port]);

  await startApi();
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'rangasso' }, body: JSON.stringify(ADMIN),
  });
  expect(login.status).toBe(200);
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  token = (await adminFetch('/api/admin/printer/devices', { name: 'Balcão (integração)' })).token;
  writeFileSync(path.join(work, 'config.json'), JSON.stringify({
    serverUrl: BASE.replace('127.0.0.1', 'localhost'), deviceToken: token,
    printer: { mode: 'auto', windowsName: '', host: '', port: 9100, columns: 0, outputDir: '' },
    dataDir: path.join(work, 'data'), logLevel: 'debug',
  }));
});

afterAll(async () => {
  await stopAgent();
  await stopApi();
  await printer.stop().catch(() => {});
  await db.end();
});

describe('integração: pedido → painel → agente → impressora', () => {
  it('pedido feito com o agente desligado imprime quando ele liga', async () => {
    const o = await placeOrder();
    expect(await printStatus(o.id)).toBe('pending');
    startAgent();
    await waitFor(async () => (await printStatus(o.id)) === 'printed', 20_000, 'pedido impresso');
    expect(ticketsFor(o.number)).toBe(1);
    const text = allText();
    expect(text).toContain('João da Integração');
    expect(text).toContain('Próximo à praça');
    const st = await adminFetch('/api/admin/printer/status');
    expect(st.devices[0]).toMatchObject({ online: true, agent_version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version });
    expect(st.devices[0].printer_state).toMatchObject({ mode: 'network', online: true });
  });

  it('pedido novo chega na impressora em poucos segundos (long-poll)', async () => {
    const t0 = Date.now();
    const o = await placeOrder();
    await waitFor(async () => (await printStatus(o.id)) === 'printed', 10_000, 'impressão rápida');
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(ticketsFor(o.number)).toBe(1);
  });

  it('clique duplo no "Enviar pedido" (mesma chave) gera um pedido e uma comanda', async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([placeOrder(key), placeOrder(key)]);
    expect(a.number).toBe(b.number);
    await waitFor(async () => (await printStatus(a.id)) === 'printed');
    await sleep(1500);
    expect(ticketsFor(a.number)).toBe(1);
    expect((await jobsOf(a.id)).length).toBe(1);
  });

  it('reimpressão pelo painel sai marcada e não altera a original', async () => {
    const o = await placeOrder();
    await waitFor(async () => (await printStatus(o.id)) === 'printed');
    const r = await adminFetch(`/api/admin/orders/${o.id}/print`, { reason: 'cliente pediu 2ª via' });
    expect(r).toMatchObject({ kind: 'reprint', reprintNumber: 1 });
    await waitFor(async () => (await jobsOf(o.id)).every((j: any) => j.status === 'printed'), 10_000, 'reimpressão');
    expect(ticketsFor(o.number)).toBe(2);
    expect(allText()).toContain('REIMPRESSÃO Nº 1');
  });

  it('sem papel: falha com motivo, tenta de novo sozinho e imprime uma vez quando o papel volta', async () => {
    printer.state.paperOut = true;
    const o = await placeOrder();
    await waitFor(async () => (await printStatus(o.id)) === 'failed', 15_000, 'falha por falta de papel');
    const [j] = await jobsOf(o.id);
    expect(j.last_error).toMatch(/papel/i);
    expect(ticketsFor(o.number)).toBe(0);
    printer.state.paperOut = false;
    await waitFor(async () => (await printStatus(o.id)) === 'printed', 40_000, 'retentativa automática');
    expect(ticketsFor(o.number)).toBe(1);
  });

  it('agente derrubado (kill -9) e religado: não duplica nada', async () => {
    const o = await placeOrder();
    await waitFor(async () => (await printStatus(o.id)) === 'printed');
    await stopAgent('SIGKILL');
    startAgent();
    await sleep(4000);
    const o2 = await placeOrder();
    await waitFor(async () => (await printStatus(o2.id)) === 'printed', 15_000);
    expect(ticketsFor(o.number)).toBe(1);
    expect(ticketsFor(o2.number)).toBe(1);
  });

  it('servidor reiniciado: agente reconecta sozinho', async () => {
    await stopApi();
    await sleep(3000);
    await startApi();
    const o = await placeOrder();
    await waitFor(async () => (await printStatus(o.id)) === 'printed', 70_000, 'reconexão após reinício do servidor');
    expect(ticketsFor(o.number)).toBe(1);
    expect(agentLog).toMatch(/restabelecida/);
  });

  it('agente morre no meio da impressão: fica "incerto", não reimprime sozinho; a loja decide', async () => {
    printer.state.holdAfterDataMs = 5000;
    let killed: Promise<void> | null = null;
    printer.onData = () => {
      printer.onData = undefined;
      killed = stopAgent('SIGKILL');
    };
    const o = await placeOrder();
    await waitFor(async () => killed !== null, 15_000, 'dados chegarem na impressora');
    await killed;
    printer.state.holdAfterDataMs = 0;
    expect(ticketsFor(o.number)).toBe(1);
    startAgent();
    await waitFor(async () => (await printStatus(o.id)) === 'uncertain', 15_000, 'status incerto');
    await sleep(3000);
    expect(ticketsFor(o.number)).toBe(1); // não reimprimiu sozinho
    // A loja confere e manda imprimir de novo pelo painel.
    const [j] = await jobsOf(o.id);
    await adminFetch(`/api/admin/print-jobs/${j.id}/resolve`, { action: 'retry' });
    await waitFor(async () => (await printStatus(o.id)) === 'printed', 15_000, 'reimpressão após decisão');
    expect(ticketsFor(o.number)).toBe(2);
  });

  it('impressora trocada no painel passa a valer sem mexer no computador', async () => {
    const other = await new FakeNetworkPrinter().start();
    await adminFetch('/api/admin/printer/status'); // sessão ok
    await db.query(`UPDATE store_settings SET printer_port = $1`, [other.port]);
    await sleep(33_000); // próximo heartbeat (até 30 s)
    const o = await placeOrder();
    await waitFor(async () => (await printStatus(o.id)) === 'printed', 15_000);
    const n = iconv.decode(Buffer.concat(other.received), 'cp860').split(`PEDIDO #${o.number}`).length - 1;
    expect(n).toBe(1);
    expect(ticketsFor(o.number)).toBe(0);
    await db.query(`UPDATE store_settings SET printer_port = $1`, [printer.port]);
    await other.stop();
  }, 80_000);

  it('chave revogada no painel: agente para de receber trabalhos', async () => {
    const st = await adminFetch('/api/admin/printer/status');
    await adminFetch(`/api/admin/printer/devices/${st.devices[0].id}/revoke`, {});
    await sleep(1000);
    const o = await placeOrder();
    await waitFor(async () => /Credencial do agente recusada/.test(agentLog), 70_000, 'agente perceber revogação');
    expect(ticketsFor(o.number)).toBe(0);
    expect(await printStatus(o.id)).toBe('pending');
  }, 90_000);
});
