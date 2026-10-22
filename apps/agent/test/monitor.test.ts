import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startMonitor, validateSetup, type MonitorHost, type MonitorSetup } from '../src/monitor.js';

let server: Server | null = null;
afterEach(() => server?.close());

function host(over: Partial<MonitorHost> = {}) {
  const saved: MonitorSetup[] = [];
  const h: MonitorHost = {
    agent: () => null,
    currentConfig: () => ({ serverUrl: 'https://rangasso.exemplo.com', hasToken: true, printer: { mode: 'auto', windowsName: '', host: '', port: 9100 } }),
    configError: () => null,
    saveConfig: async (s) => void saved.push(s),
    logTail: () => ['linha 1'],
    listPrinters: async () => [{ name: 'EPSON TM-T20 Receipt', default: true }],
    testConnection: async (_u, t) => {
      if (!t.startsWith('rgd_valida')) throw new Error('Credencial do agente inválida ou revogada.');
      return { deviceName: 'Balcão' };
    },
    ...over,
  };
  return { h, saved };
}

async function start(h: MonitorHost) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  server = await startMonitor(h, port);
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = { 'x-rangasso-monitor': '1' }) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { base, port, post };
}

describe('Monitor de Impressão', () => {
  it('serve a página e o estado sem expor a chave', async () => {
    const { h } = host();
    const { base } = await start(h);
    const page = await fetch(base + '/');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Monitor de Impressão');
    const st = await (await fetch(base + '/api/state')).json();
    expect(st.configured).toBe(true);
    expect(JSON.stringify(st)).not.toContain('rgd_');
    expect(st.config.hasToken).toBe(true);
    expect(st.log).toEqual(['linha 1']);
  });

  it('recusa outro Host (DNS rebinding) e POST sem o cabeçalho ou de outra origem', async () => {
    const { h, saved } = host();
    const { base, post, port } = await start(h);
    const http = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { host: 'site-malicioso.com' } }, (r) => resolve(r.statusCode!));
    });
    expect(status).toBe(403);
    expect((await post('/api/setup', { serverUrl: 'https://x.com' }, {})).status).toBe(403);
    expect((await post('/api/setup', { serverUrl: 'https://x.com' }, { 'x-rangasso-monitor': '1', origin: 'https://site-malicioso.com' })).status).toBe(403);
    expect(saved).toHaveLength(0);
    expect((await fetch(base + '/api/printers')).status).toBe(200);
  });

  it('valida a configuração e só grava depois de testar a chave nova', async () => {
    const { h, saved } = host();
    const { post } = await start(h);
    let r = await post('/api/setup', { serverUrl: 'http://site.com', deviceToken: 'abc', printer: { mode: 'auto' } });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/https:\/\//);
    r = await post('/api/setup', { serverUrl: 'https://site.com', deviceToken: 'rgd_errada_00000000000000000000', printer: { mode: 'auto' } });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/Não consegui conectar/);
    expect(saved).toHaveLength(0);
    r = await post('/api/setup', { serverUrl: 'https://site.com/', deviceToken: 'rgd_valida_0000000000000000000', printer: { mode: 'windows', windowsName: 'EPSON TM-T20 Receipt' } });
    expect(r.status).toBe(200);
    expect(saved[0]).toMatchObject({ serverUrl: 'https://site.com', deviceToken: 'rgd_valida_0000000000000000000', printer: { mode: 'windows', windowsName: 'EPSON TM-T20 Receipt' } });
    // Mantendo a chave atual (campo vazio): grava sem testar.
    r = await post('/api/setup', { serverUrl: 'https://outro.com', deviceToken: '', printer: { mode: 'network', host: '192.168.0.50', port: 9100 } });
    expect(r.status).toBe(200);
    expect(saved[1].deviceToken).toBeUndefined();
  });

  it('exige chave no primeiro acesso e dados da impressora conforme o modo', () => {
    expect(() => validateSetup({ serverUrl: 'https://a.com', printer: { mode: 'auto' } }, false)).toThrow(/Informe a chave/);
    expect(() => validateSetup({ serverUrl: 'https://a.com', printer: { mode: 'windows' } }, true)).toThrow(/impressora do Windows/);
    expect(() => validateSetup({ serverUrl: 'https://a.com', printer: { mode: 'network', host: '' } }, true)).toThrow(/IP/);
    expect(validateSetup({ serverUrl: 'http://localhost:3000', printer: {} }, true).printer.mode).toBe('auto');
  });

  it('imprimir teste sem agente configurado responde 409', async () => {
    const { h } = host({ agent: () => null, currentConfig: () => null });
    const { post } = await start(h);
    const r = await post('/api/test-print', {});
    expect(r.status).toBe(409);
  });
});
