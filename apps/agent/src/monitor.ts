import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Agent } from './agent.js';
import { AGENT_VERSION } from './agent.js';
import { AgentApi } from './api.js';
import { MONITOR_HTML } from './monitorPage.js';
import { listWindowsPrinters } from './printers/windows.js';

// Monitor de Impressão: página local (só neste computador, 127.0.0.1) para ver o estado do agente,
// configurar o endereço do sistema e a chave, escolher a impressora e imprimir um teste.
// Não fica acessível pela rede da loja. A chave do agente nunca é devolvida pela página.

export const MONITOR_PORT = 17800;

export interface MonitorSetup {
  serverUrl: string;
  deviceToken?: string; // vazio = mantém a atual
  printer: { mode: 'auto' | 'windows' | 'network'; windowsName?: string; host?: string; port?: number };
}

export interface MonitorHost {
  agent(): Agent | null;
  // Configuração atual sem a chave (null = ainda não configurado).
  currentConfig(): { serverUrl: string; hasToken: boolean; printer: { mode: string; windowsName: string; host: string; port: number } } | null;
  configError(): string | null;
  saveConfig(setup: MonitorSetup): Promise<void>;
  logTail(lines: number): string[];
  listPrinters?: () => Promise<{ name: string; default?: boolean }[]>;
  testConnection?: (serverUrl: string, token: string) => Promise<{ deviceName: string }>;
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 32_000) throw new Error('Requisição grande demais.');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function validateSetup(b: any, hasToken: boolean): MonitorSetup {
  const serverUrl = String(b?.serverUrl ?? '').trim().replace(/\/+$/, '');
  const deviceToken = String(b?.deviceToken ?? '').trim();
  const mode = ['auto', 'windows', 'network'].includes(b?.printer?.mode) ? b.printer.mode : 'auto';
  const problems: string[] = [];
  if (!/^https:\/\/[^\s/]+/.test(serverUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(serverUrl)) problems.push('O endereço do sistema precisa começar com https://');
  if (deviceToken && !/^rgd_[A-Za-z0-9_-]{20,80}$/.test(deviceToken)) problems.push('A chave do agente começa com rgd_. Copie do painel.');
  if (!deviceToken && !hasToken) problems.push('Informe a chave do agente (Painel > Configurações > Impressora > + Credencial de agente).');
  const windowsName = String(b?.printer?.windowsName ?? '').trim().slice(0, 200);
  const host = String(b?.printer?.host ?? '').trim().slice(0, 200);
  const port = Number(b?.printer?.port) || 9100;
  if (mode === 'windows' && !windowsName) problems.push('Escolha a impressora do Windows.');
  if (mode === 'network' && !/^[A-Za-z0-9.-]+$/.test(host)) problems.push('Informe o IP da impressora de rede.');
  if (port < 1 || port > 65535) problems.push('Porta inválida.');
  if (problems.length) throw Object.assign(new Error(problems.join(' ')), { status: 400 });
  return { serverUrl, deviceToken: deviceToken || undefined, printer: { mode, windowsName, host, port } };
}

export function startMonitor(host: MonitorHost, port = MONITOR_PORT, bind = '127.0.0.1'): Promise<Server> {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const server = createServer(async (req, res) => {
    try {
      // Proteção contra outro site no navegador tentando falar com o monitor (DNS rebinding / CSRF).
      const h = req.headers.host ?? '';
      if (!allowedHosts.has(h) && !allowedHosts.has(h.replace(/^\[::1\]/, 'localhost'))) return send(res, 403, { error: 'Acesso permitido só por http://127.0.0.1:' + port });
      const url = new URL(req.url ?? '/', `http://${h}`);
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if ((origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) || req.headers['x-rangasso-monitor'] !== '1') return send(res, 403, { error: 'Origem não permitida.' });
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, MONITOR_HTML, 'text/html; charset=utf-8');

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const agent = host.agent();
        const snap = agent ? await agent.snapshot(url.searchParams.get('refresh') === '1') : null;
        return send(res, 200, {
          version: AGENT_VERSION,
          configured: !!host.currentConfig(),
          config: host.currentConfig(),
          configError: host.configError(),
          panelPrinter: agent?.printerConfigFromPanel ?? null,
          agent: snap,
          log: host.logTail(60),
          now: new Date().toISOString(),
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/printers') {
        const list = await (host.listPrinters ?? listWindowsPrinters)();
        return send(res, 200, { printers: list.map((p) => ({ name: p.name, default: !!p.default })) });
      }

      if (req.method === 'POST' && url.pathname === '/api/setup') {
        const cur = host.currentConfig();
        const setup = validateSetup(await readJson(req), !!cur?.hasToken);
        // Testa antes de gravar quando a chave foi trocada; com a chave atual, grava e o agente reconecta.
        if (setup.deviceToken) {
          const test = host.testConnection ?? (async (u: string, t: string) => {
            const r = await new AgentApi(u, t, AGENT_VERSION).heartbeat({ agentVersion: AGENT_VERSION, printer: { mode: 'setup', target: '', online: null } });
            return { deviceName: r.device.name };
          });
          try {
            await test(setup.serverUrl, setup.deviceToken);
          } catch (e) {
            return send(res, 400, { error: `Não consegui conectar com essa chave: ${(e as Error).message}` });
          }
        }
        await host.saveConfig(setup);
        return send(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/test-print') {
        const agent = host.agent();
        if (!agent) return send(res, 409, { error: 'Configure o agente primeiro.' });
        try {
          const r = await agent.testPrint();
          return send(res, 200, { ok: true, outcome: r.outcome, detail: r.detail });
        } catch (e) {
          return send(res, 500, { error: (e as Error).message });
        }
      }

      return send(res, 404, { error: 'Não encontrado.' });
    } catch (e) {
      const status = (e as any)?.status ?? 500;
      return send(res, status, { error: (e as Error).message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
