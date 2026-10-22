import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../src/agent.js';
import { ApiError, type AgentApi, type ServerJob, type ServerPrinterConfig } from '../src/api.js';
import type { AgentConfig } from '../src/config.js';
import { Journal } from '../src/journal.js';
import { Logger } from '../src/logger.js';
import { NetworkPrinter } from '../src/printers/network.js';
import { PrinterError, type Printer } from '../src/printers/types.js';
import { FakeNetworkPrinter } from './fakePrinter.js';
import { orderPayload } from './receipt.test.js';

// Servidor falso que segue as mesmas regras de transição do servidor real.
class FakeApi {
  reports: { jobId: string; status: string; detail: string }[] = [];
  queue: ServerJob[] = [];
  offline = false;
  failNextReport = 0;
  printer: ServerPrinterConfig = { connection: 'network', host: '127.0.0.1', port: 0, windowsName: '', columns: 48, model: 'TM-T20' };
  heartbeats: any[] = [];
  private net() {
    if (this.offline) throw new ApiError(0, 'network', 'Sem conexão com o servidor');
  }
  async heartbeat(body: any) {
    this.net();
    this.heartbeats.push(body);
    return { ok: true, serverTime: new Date().toISOString(), device: { name: 'Caixa' }, printer: this.printer };
  }
  async jobs() {
    this.net();
    const j = this.queue;
    this.queue = [];
    return { jobs: j };
  }
  async report(jobId: string, status: string, detail: string) {
    this.net();
    if (this.failNextReport > 0) {
      this.failNextReport--;
      throw new ApiError(0, 'network', 'caiu');
    }
    this.reports.push({ jobId, status, detail });
    return { ok: true, status };
  }
  statuses(jobId: string) {
    return this.reports.filter((r) => r.jobId === jobId).map((r) => r.status);
  }
}

const job = (id: string, claimId = '2026-10-21T22:00:00.000Z', over: Partial<ServerJob> = {}): ServerJob => ({
  id, claimId, kind: 'original', reprintNumber: 0, copies: 1, attempt: 1, payload: orderPayload(), createdAt: new Date().toISOString(), ...over,
});

let dir: string;
let fakePrinter: FakeNetworkPrinter;
let api: FakeApi;
const cfg = (): AgentConfig => ({
  serverUrl: 'http://localhost:3000', deviceToken: 'rgd_' + 'x'.repeat(30),
  printer: { mode: 'auto', windowsName: '', host: '', port: 9100, columns: 0, outputDir: '' },
  dataDir: dir, logLevel: 'error', configPath: path.join(dir, 'config.json'),
});
const mkAgent = (factory?: (c: AgentConfig, s: ServerPrinterConfig | null) => Printer) =>
  new Agent(cfg(), new Logger(dir, 'error', false), { api: api as unknown as AgentApi, longPollSeconds: 0, printerFactory: factory, sleep: async () => {} });

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'rg-agent-'));
  fakePrinter = await new FakeNetworkPrinter().start();
  api = new FakeApi();
  api.printer.port = fakePrinter.port;
});
afterEach(async () => {
  await fakePrinter.stop();
});

describe('agente: fluxo normal', () => {
  it('usa a impressora definida no painel (modo auto) e informa "impresso"', async () => {
    const a = mkAgent();
    api.queue.push(job('j1'));
    await a.tick();
    expect(fakePrinter.cuts()).toBe(1);
    expect(api.statuses('j1')).toEqual(['sending', 'printed']);
    expect(api.heartbeats.at(-1).printer).toMatchObject({ mode: 'network', target: `127.0.0.1:${fakePrinter.port}`, online: true });
  });

  it('imprime as vias configuradas', async () => {
    const a = mkAgent();
    api.queue.push(job('j1', undefined, { copies: 2 }));
    await a.tick();
    expect(fakePrinter.cuts()).toBe(2);
  });
});

describe('agente: anti-duplicação', () => {
  it('não reimprime o mesmo trabalho/reserva entregue de novo', async () => {
    const a = mkAgent();
    api.queue.push(job('j1'));
    await a.tick();
    api.queue.push(job('j1'));
    await a.tick();
    expect(fakePrinter.cuts()).toBe(1);
    expect(api.statuses('j1')).toEqual(['sending', 'printed', 'printed']);
  });

  it('se o servidor não confirma "sending", não imprime', async () => {
    const a = mkAgent();
    api.failNextReport = 1;
    api.queue.push(job('j1'));
    await expect(a.tick()).rejects.toThrow();
    expect(fakePrinter.cuts()).toBe(0);
    // reserva expira, servidor entrega de novo com nova reserva: agora imprime uma vez
    api.queue.push(job('j1', '2026-10-21T22:05:00.000Z'));
    await a.tick();
    expect(fakePrinter.cuts()).toBe(1);
  });

  it('agente reiniciado no meio da impressão: marca incerto e não reimprime', async () => {
    const j = new Journal(dir);
    j.markSending('j9@c1', 'j9', 'pedido #9');
    const a = mkAgent();
    a.recoverInterrupted();
    await a.tick();
    expect(api.statuses('j9')).toEqual(['uncertain']);
    expect(fakePrinter.cuts()).toBe(0);
  });

  it('sem internet após imprimir: resultado fica na fila local e é reenviado depois', async () => {
    const a = mkAgent();
    api.queue.push(job('j1'));
    // cai a conexão logo depois do "sending"
    const orig = api.report.bind(api);
    api.report = async (id, st, d) => {
      const r = await orig(id, st, d);
      if (st === 'sending') api.offline = true;
      return r;
    };
    await a.tick();
    expect(fakePrinter.cuts()).toBe(1);
    expect(a.journal.outbox.length).toBe(1);
    // reinício do agente com a fila persistida
    api.offline = false;
    const b = mkAgent();
    await b.tick();
    expect(api.statuses('j1')).toEqual(['sending', 'printed']);
    expect(b.journal.outbox.length).toBe(0);
    expect(fakePrinter.cuts()).toBe(1);
  });

  it('aviso recusado pelo servidor (4xx) é descartado da fila', async () => {
    const a = mkAgent();
    a.journal.enqueue({ jobId: 'jx', status: 'printed', detail: '' });
    api.report = async () => {
      throw new ApiError(409, 'invalid_job_transition', 'x');
    };
    await a.flushOutbox();
    expect(a.journal.outbox.length).toBe(0);
  });
});

describe('agente: falhas da impressora', () => {
  it('sem papel: informa falha (seguro tentar de novo) e nada é impresso', async () => {
    fakePrinter.state.paperOut = true;
    const a = mkAgent();
    api.queue.push(job('j1'));
    await a.tick();
    expect(api.statuses('j1')).toEqual(['sending', 'failed']);
    expect(api.reports.at(-1)!.detail).toMatch(/papel/i);
    expect(fakePrinter.cuts()).toBe(0);
  });

  it('impressora desligada (porta fechada): falha segura', async () => {
    await fakePrinter.stop();
    const a = mkAgent();
    api.queue.push(job('j1'));
    await a.tick();
    expect(api.statuses('j1')).toEqual(['sending', 'failed']);
    fakePrinter = await new FakeNetworkPrinter().start(); // para o afterEach
  });

  it('conexão cai depois de enviar os dados: incerto (não reimprime sozinho)', async () => {
    fakePrinter.state.dropAfterData = true;
    const a = mkAgent();
    api.queue.push(job('j1'));
    await a.tick();
    expect(api.statuses('j1')).toEqual(['sending', 'uncertain']);
  });

  it('impressora que não responde a status: "enviado" sem confirmação física', async () => {
    fakePrinter.state.silent = true;
    const a = mkAgent();
    api.queue.push(job('j1'));
    await a.tick();
    expect(api.statuses('j1')).toEqual(['sending', 'sent']);
    expect(fakePrinter.cuts()).toBe(1);
  }, 15_000);

  it('erro de envio sem garantia: incerto', async () => {
    const a = mkAgent(() => ({ mode: 'fake', target: 'x', status: async () => ({ online: true }), print: async () => { throw new PrinterError('timeout no spooler', false); } }));
    api.queue.push(job('j1'));
    await a.tick();
    expect(api.statuses('j1')).toEqual(['sending', 'uncertain']);
  });
});

describe('agente: configuração', () => {
  it('modo auto sem IP no painel: falha clara, sem travar', async () => {
    api.printer = { ...api.printer, host: '' };
    const a = mkAgent();
    api.queue.push(job('j1'));
    await a.tick();
    expect(api.statuses('j1')).toEqual(['failed']);
    expect(api.reports[0].detail).toMatch(/IP da impressora/);
  });

  it('troca de impressora no painel é aplicada no próximo heartbeat', async () => {
    const other = await new FakeNetworkPrinter().start();
    const a = new Agent(cfg(), new Logger(dir, 'error', false), { api: api as unknown as AgentApi, longPollSeconds: 0, heartbeatMs: 0 });
    api.queue.push(job('j1'));
    await a.tick();
    api.printer = { ...api.printer, port: other.port };
    api.queue.push(job('j2'));
    await a.tick();
    expect(fakePrinter.cuts()).toBe(1);
    expect(other.cuts()).toBe(1);
    await other.stop();
  });

  it('run() continua após queda do servidor e para com stop()', async () => {
    let n = 0;
    const a = new Agent(cfg(), new Logger(dir, 'error', false), {
      api: api as unknown as AgentApi, longPollSeconds: 0,
      sleep: async () => { if (++n === 3) { api.offline = false; api.queue.push(job('j1')); } },
    });
    api.offline = true;
    const orig = api.jobs.bind(api);
    api.jobs = async () => {
      const r = await orig();
      if (r.jobs.length === 0 && fakePrinter.cuts() > 0) a.stop();
      return r;
    };
    await a.run();
    expect(fakePrinter.cuts()).toBe(1);
    expect(n).toBeGreaterThanOrEqual(3);
  });
});

describe('impressora de rede (direto)', () => {
  it('status online / sem papel / tampa aberta', async () => {
    const p = new NetworkPrinter('127.0.0.1', fakePrinter.port);
    expect((await p.status()).online).toBe(true);
    fakePrinter.state.paperOut = true;
    expect(await p.status()).toMatchObject({ paperOut: true, error: 'Sem papel' });
    fakePrinter.state.paperOut = false;
    fakePrinter.state.coverOpen = true;
    expect(await p.status()).toMatchObject({ coverOpen: true, error: 'Tampa aberta' });
  });
});

describe('diário local', () => {
  it('sobrevive a reinício e a arquivo corrompido', async () => {
    const j = new Journal(dir);
    j.enqueue({ jobId: 'a', status: 'printed', detail: '' });
    expect(new Journal(dir).outbox.length).toBe(1);
    const fs = await import('node:fs');
    fs.writeFileSync(path.join(dir, 'state.json'), '{quebrado');
    const k = new Journal(dir);
    expect(k.outbox.length).toBe(0);
    expect(readdirSync(dir).some((f) => f.includes('corrompido'))).toBe(true);
  });
});
