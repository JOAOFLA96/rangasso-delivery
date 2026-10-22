import path from 'node:path';
import { AgentApi, ApiError, type ServerJob, type ServerPrinterConfig } from './api.js';
import type { AgentConfig } from './config.js';
import { Journal, type ReportStatus } from './journal.js';
import type { Logger } from './logger.js';
import { FilePrinter } from './printers/file.js';
import { NetworkPrinter } from './printers/network.js';
import { PrinterError, type Printer, type PrinterStatus } from './printers/types.js';
import { WindowsPrinter } from './printers/windows.js';
import { renderEscPos, type ReceiptPayload } from './receipt.js';

// Laço principal do agente:
//  1. Ao iniciar, tudo que estava "imprimindo" quando o agente parou vira "incerto" (nunca reimprime sozinho).
//  2. Envia sinal de vida (heartbeat) com o estado da impressora e recebe a configuração do painel.
//  3. Esvazia a caixa de saída (avisos ao servidor que ficaram pendentes por falta de internet).
//  4. Espera trabalhos (long-poll) e imprime um por vez.
// Regra anti-duplicação: só imprime depois que o servidor aceitou o aviso "sending" e o diário local foi gravado.

declare const __AGENT_VERSION__: string | undefined;
// Substituído no build pelo esbuild (--define); 'dev' quando roda direto do código-fonte.
export const AGENT_VERSION: string = typeof __AGENT_VERSION__ === 'string' ? __AGENT_VERSION__ : 'dev';

const HEARTBEAT_MS = 30_000;
const STATUS_CACHE_MS = 30_000;
const LONG_POLL_SECONDS = 25;

export interface AgentOptions {
  api?: AgentApi;
  printerFactory?: (cfg: AgentConfig, server: ServerPrinterConfig | null) => Printer;
  heartbeatMs?: number;
  longPollSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function createPrinter(cfg: AgentConfig, server: ServerPrinterConfig | null): Printer {
  const tmp = path.join(cfg.dataDir, 'tmp');
  const p = cfg.printer;
  switch (p.mode) {
    case 'windows':
      return new WindowsPrinter(p.windowsName, tmp);
    case 'network':
      return new NetworkPrinter(p.host, p.port);
    case 'file':
      return new FilePrinter(p.outputDir);
    default:
      if (!server) throw new PrinterError('Aguardando a configuração da impressora vinda do painel.');
      if (server.connection === 'network') {
        if (!server.host) throw new PrinterError('Painel: informe o IP da impressora em Configurações > Impressora.');
        return new NetworkPrinter(server.host, server.port || 9100);
      }
      // USB e serial passam pelo spooler do Windows (driver da Epson / porta virtual).
      if (!server.windowsName) throw new PrinterError('Painel: informe o nome da impressora no Windows em Configurações > Impressora.');
      return new WindowsPrinter(server.windowsName, tmp);
  }
}

export class Agent {
  readonly api: AgentApi;
  readonly journal: Journal;
  private serverPrinter: ServerPrinterConfig | null = null;
  private printer: Printer | null = null;
  private printerKey = '';
  private status: (PrinterStatus & { checkedAt: string }) | null = null;
  private lastHeartbeat = 0;
  private stopping = false;
  private backoffMs = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  private sleepAbort: (() => void) | null = null;
  readonly stats = { printed: 0, failed: 0, uncertain: 0 };
  // Estado da conexão com o servidor, exibido no Monitor de Impressão.
  readonly connection: { ok: boolean | null; lastOkAt: string | null; lastError: string | null; deviceName: string | null } = { ok: null, lastOkAt: null, lastError: null, deviceName: null };
  readonly startedAt = new Date().toISOString();

  constructor(private cfg: AgentConfig, private log: Logger, private opts: AgentOptions = {}) {
    this.api = opts.api ?? new AgentApi(cfg.serverUrl, cfg.deviceToken, AGENT_VERSION);
    this.journal = new Journal(cfg.dataDir);
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => {
      const t = setTimeout(() => { this.sleepAbort = null; resolve(); }, ms);
      this.sleepAbort = () => { clearTimeout(t); this.sleepAbort = null; resolve(); };
    }));
  }

  stop() {
    this.stopping = true;
    this.sleepAbort?.();
    (this.api as Partial<AgentApi>).abortAll?.();
  }

  get config() {
    return this.cfg;
  }

  get printerConfigFromPanel() {
    return this.serverPrinter;
  }

  // Resumo para o Monitor de Impressão (nunca inclui a chave do agente).
  async snapshot(refreshPrinter = false) {
    let printer: { mode: string; target: string } | null = null;
    let printerError: string | null = null;
    try {
      const p = this.resolvePrinter();
      printer = { mode: p.mode, target: p.target };
    } catch (e) {
      printerError = (e as Error).message;
    }
    const status = printer ? await this.printerStatus(refreshPrinter) : null;
    return {
      connection: { ...this.connection },
      printer,
      printerError,
      printerStatus: status,
      columns: this.columns(),
      stats: { ...this.stats },
      pending: this.journal.outbox.length,
      recent: this.journal.recent(20),
      startedAt: this.startedAt,
    };
  }

  // Comanda de teste direto na impressora, sem passar pelo servidor.
  async testPrint() {
    const printer = this.resolvePrinter();
    const columns = this.columns();
    const data = renderEscPos(
      { test: true, store: { name: 'RANGASSO', timezone: 'America/Sao_Paulo' }, columns, createdAt: new Date().toISOString() },
      { kind: 'test', reprintNumber: 0, copies: 1 },
    );
    const r = await printer.print(data, 'rangasso-teste');
    this.status = null;
    this.log.info(`Teste local: ${r.outcome === 'printed' ? 'impresso (confirmado pela impressora)' : 'enviado à impressora'}`);
    return r;
  }

  columns() {
    return this.cfg.printer.columns || this.serverPrinter?.columns || 48;
  }

  // Resolve (e reaproveita) a impressora conforme o config local ou o painel.
  resolvePrinter(): Printer {
    const factory = this.opts.printerFactory ?? createPrinter;
    const key = JSON.stringify([this.cfg.printer.mode, this.cfg.printer.mode === 'auto' ? this.serverPrinter : null]);
    if (!this.printer || key !== this.printerKey) {
      this.printer = factory(this.cfg, this.serverPrinter);
      this.printerKey = key;
      this.status = null;
      this.log.info(`Impressora em uso: ${this.printer.mode} → ${this.printer.target}`);
    }
    return this.printer;
  }

  private async printerStatus(force = false) {
    if (!force && this.status && Date.now() - Date.parse(this.status.checkedAt) < STATUS_CACHE_MS) return this.status;
    let st: PrinterStatus;
    try {
      st = await this.resolvePrinter().status();
    } catch (e) {
      st = { online: false, error: (e as Error).message };
    }
    this.status = { ...st, checkedAt: new Date().toISOString() };
    return this.status;
  }

  // Ao iniciar: o que ficou no meio da impressão é incerto. A loja confere e decide no painel.
  recoverInterrupted() {
    for (const [key, e] of this.journal.interrupted()) {
      this.log.warn(`Trabalho ${e.label} estava sendo impresso quando o agente parou. Marcado como incerto.`);
      this.journal.markDone(key, 'uncertain');
      this.journal.enqueue({ jobId: e.jobId, status: 'uncertain', detail: 'O agente foi interrompido durante a impressão. Confira se a comanda saiu.' });
      this.stats.uncertain++;
    }
  }

  async heartbeat(): Promise<Awaited<ReturnType<AgentApi['heartbeat']>>> {
    const st = await this.printerStatus();
    const p = this.printer;
    const r = await this.api.heartbeat({
      agentVersion: AGENT_VERSION,
      printer: {
        mode: p?.mode ?? this.cfg.printer.mode,
        target: (p?.target ?? '').slice(0, 200),
        online: st.online,
        paperOut: st.paperOut ?? null,
        coverOpen: st.coverOpen ?? null,
        error: st.error ? st.error.slice(0, 500) : null,
        checkedAt: st.checkedAt,
      },
      localQueue: this.journal.outbox.length,
    });
    this.lastHeartbeat = Date.now();
    Object.assign(this.connection, { ok: true, lastOkAt: new Date().toISOString(), lastError: null, deviceName: r.device.name });
    const changed = JSON.stringify(r.printer) !== JSON.stringify(this.serverPrinter);
    this.serverPrinter = r.printer;
    if (changed && this.cfg.printer.mode === 'auto') {
      // Impressora (re)definida no painel: avalia já e manda o estado real, sem esperar o próximo ciclo.
      this.status = null;
      return this.heartbeat();
    }
    return r;
  }

  // Reenvia avisos pendentes. Erros 4xx (ex.: trabalho cancelado no painel) descartam o aviso; rede/5xx mantém.
  async flushOutbox() {
    for (const e of [...this.journal.outbox]) {
      try {
        await this.api.report(e.jobId, e.status, e.detail);
        this.journal.removeOutbox(e);
      } catch (err) {
        if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429) {
          this.log.warn(`Aviso "${e.status}" do trabalho ${e.jobId} recusado pelo servidor (${err.code}); descartado.`);
          this.journal.removeOutbox(e);
          continue;
        }
        this.journal.touchOutbox(e);
        throw err;
      }
    }
  }

  private async report(jobId: string, status: ReportStatus, detail: string) {
    this.journal.enqueue({ jobId, status, detail });
    try {
      await this.flushOutbox();
    } catch (e) {
      this.log.warn(`Aviso "${status}" ficou na fila local; será reenviado.`, e);
    }
  }

  async handleJob(job: ServerJob) {
    const key = `${job.id}@${job.claimId}`;
    const label = job.kind === 'test' ? `teste ${job.id.slice(0, 8)}` : `pedido #${job.payload?.order?.number ?? '?'}${job.kind === 'reprint' ? ` (reimpressão ${job.reprintNumber})` : ''}`;
    const prev = this.journal.get(key);
    if (prev) {
      // Mesmo trabalho e mesma reserva já tratados: nunca imprimir de novo, só reenviar o resultado.
      this.log.warn(`Trabalho ${label} já tratado localmente (${prev.outcome ?? prev.state}); não será reimpresso.`);
      if (prev.state === 'done' && prev.outcome) await this.report(job.id, prev.outcome, 'Resultado reenviado pelo agente.');
      return;
    }

    let printer: Printer;
    let data: Buffer;
    try {
      printer = this.resolvePrinter();
      const payload: ReceiptPayload = { ...job.payload, columns: this.cfg.printer.columns || job.payload?.columns || this.columns() };
      data = renderEscPos(payload, { kind: job.kind, reprintNumber: job.reprintNumber, copies: job.copies });
    } catch (e) {
      this.log.error(`Não foi possível preparar ${label}.`, e);
      await this.report(job.id, 'failed', (e as Error).message);
      this.stats.failed++;
      return;
    }

    // Antes de imprimir: diário local + servidor precisam registrar "imprimindo".
    this.journal.markSending(key, job.id, label);
    try {
      await this.api.report(job.id, 'sending', `Enviando para ${printer.mode}: ${printer.target}`.slice(0, 500));
    } catch (e) {
      // Nada foi impresso. O servidor devolve o trabalho para a fila quando a reserva expirar.
      this.journal.forget(key);
      this.log.warn(`Servidor não confirmou o início de ${label}; impressão adiada.`, e);
      throw e;
    }

    this.log.info(`Imprimindo ${label} (${job.copies} via(s), ${data.length} bytes)`);
    let outcome: ReportStatus;
    let detail: string;
    try {
      const r = await printer.print(data, `rangasso-${job.id.slice(0, 8)}`);
      outcome = r.outcome;
      detail = r.detail;
      this.stats.printed++;
      this.log.info(`${label}: ${outcome === 'printed' ? 'impresso (confirmado pela impressora)' : 'enviado à impressora'}`);
    } catch (e) {
      const safe = e instanceof PrinterError ? e.safeToRetry : false;
      outcome = safe ? 'failed' : 'uncertain';
      detail = (e as Error).message;
      if (safe) this.stats.failed++;
      else this.stats.uncertain++;
      this.log.error(`${label}: ${safe ? 'falhou (nada impresso, vai tentar de novo)' : 'resultado incerto'}`, e);
      this.status = null;
    }
    this.journal.markDone(key, outcome);
    await this.report(job.id, outcome, detail);
  }

  // Um ciclo: heartbeat se vencido, esvazia fila, busca e processa trabalhos.
  async tick() {
    if (Date.now() - this.lastHeartbeat >= (this.opts.heartbeatMs ?? HEARTBEAT_MS)) await this.heartbeat();
    await this.flushOutbox();
    // A espera termina a tempo do próximo heartbeat: estado da impressora e configuração do painel em até ~30 s.
    const untilHeartbeat = Math.ceil(((this.opts.heartbeatMs ?? HEARTBEAT_MS) - (Date.now() - this.lastHeartbeat)) / 1000);
    const wait = Math.min(this.opts.longPollSeconds ?? LONG_POLL_SECONDS, Math.max(1, untilHeartbeat));
    const { jobs } = await this.api.jobs(this.opts.longPollSeconds === 0 ? 0 : wait);
    for (const job of jobs) {
      if (this.stopping) break;
      await this.handleJob(job);
    }
    return jobs.length;
  }

  async run() {
    this.log.info(`Agente Rangasso ${AGENT_VERSION} iniciando. Servidor: ${this.cfg.serverUrl}`);
    this.recoverInterrupted();
    while (!this.stopping) {
      try {
        await this.tick();
        if (this.backoffMs) this.log.info('Conexão com o servidor restabelecida.');
        this.backoffMs = 0;
        this.connection.ok = true;
        this.connection.lastOkAt = new Date().toISOString();
        this.connection.lastError = null;
      } catch (e) {
        if (this.stopping) break;
        this.connection.ok = false;
        this.connection.lastError = e instanceof ApiError && e.status === 401
          ? 'Chave do agente recusada (revogada ou inválida). Gere uma nova no painel.'
          : (e as Error).message;
        if (e instanceof ApiError && e.status === 401) {
          this.log.error('Credencial do agente recusada (revogada ou inválida). Gere uma nova chave no painel e atualize o config.json.');
          await this.sleep(60_000);
          continue;
        }
        this.backoffMs = Math.min(this.backoffMs ? this.backoffMs * 2 : 2000, 60_000);
        this.log.warn(`Erro no ciclo; nova tentativa em ${Math.round(this.backoffMs / 1000)} s.`, e);
        this.lastHeartbeat = 0;
        await this.sleep(this.backoffMs);
      }
    }
    this.log.info('Agente parado.');
  }
}
