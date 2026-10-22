import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Agent, AGENT_VERSION } from './agent.js';
import { AgentApi } from './api.js';
import { defaultConfigPath, defaultDataDir, loadConfig, type AgentConfig } from './config.js';
import { Journal } from './journal.js';
import { Logger } from './logger.js';
import { MONITOR_PORT, startMonitor, type MonitorHost, type MonitorSetup } from './monitor.js';
import { listWindowsPrinters } from './printers/windows.js';
import { renderEscPos, renderText, type ReceiptPayload } from './receipt.js';
import { downloadUpdate, markHealthy, pickUpdate } from './updater.js';

const UPDATE_FIRST_CHECK_MS = Number(process.env.RANGASSO_UPDATE_FIRST_MS ?? 2 * 60_000);
const UPDATE_EVERY_MS = 6 * 3600_000;
export const RESTART_FOR_UPDATE_EXIT_CODE = 3;

const HELP = `Agente de impressão Rangasso ${AGENT_VERSION}

Uso: rangasso-agent <comando> [--config caminho\\config.json]

Comandos:
  run               Inicia o agente e o Monitor de Impressão em http://127.0.0.1:${MONITOR_PORT} (é o que o serviço executa)
                    [--monitor-port 17800] [--no-monitor]
  setup             Grava o config.json: --server https://... --token rgd_... [--printer auto|windows|network|file]
                    [--windows-name "EPSON TM-T20"] [--host 192.168.0.50] [--port 9100] [--columns 48] [--output-dir pasta]
  test-connection   Testa a conexão e a chave com o servidor
  test-print        Imprime uma comanda de teste direto na impressora (sem passar pelo servidor)
  list-printers     Lista as impressoras instaladas no Windows
  status            Mostra configuração, impressora em uso, fila local e últimos resultados
  preview           Mostra em texto a comanda de teste na largura configurada
  version           Mostra a versão
`;

function args(argv: string[]) {
  const out: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      out[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    } else rest.push(a);
  }
  return { flags: out, rest };
}

function testPayload(cfg: AgentConfig, columns: number): ReceiptPayload {
  return { test: true, store: { name: 'RANGASSO', timezone: 'America/Sao_Paulo' }, columns, createdAt: new Date().toISOString() };
}

interface ConfigPatch {
  serverUrl?: string;
  deviceToken?: string;
  printer?: Partial<{ mode: string; windowsName: string; host: string; port: number; columns: number; outputDir: string }>;
}

// Grava o config.json mesclando com o atual. Valida num arquivo temporário antes de substituir.
function writeConfig(configPath: string, patch: ConfigPatch) {
  let current: any = {};
  if (existsSync(configPath)) {
    try {
      current = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      current = {};
    }
  }
  const printer = { mode: 'auto', windowsName: '', host: '', port: 9100, columns: 0, outputDir: '', ...(current.printer ?? {}) };
  for (const [k, v] of Object.entries(patch.printer ?? {})) if (v !== undefined) (printer as any)[k] = v;
  const next = {
    serverUrl: patch.serverUrl ?? current.serverUrl ?? '',
    deviceToken: patch.deviceToken ?? current.deviceToken ?? '',
    printer,
    dataDir: current.dataDir ?? defaultDataDir(),
    logLevel: current.logLevel ?? 'info',
  };
  mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = configPath + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  try {
    loadConfig(tmp);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Error((e as Error).message.replace(tmp, configPath));
  }
  writeFileSync(configPath, JSON.stringify(next, null, 2));
  rmSync(tmp, { force: true });
}

function tailLog(dataDir: string, lines: number): string[] {
  try {
    const dir = path.join(dataDir, 'logs');
    const files = readdirSync(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.log')).sort();
    const out: string[] = [];
    for (let i = files.length - 1; i >= 0 && out.length < lines; i--) {
      const content = readFileSync(path.join(dir, files[i]), 'utf8').split('\n').filter(Boolean);
      out.unshift(...content.slice(-(lines - out.length)));
    }
    return out;
  } catch {
    return [];
  }
}

// Serviço: Monitor de Impressão sempre no ar; o agente roda quando há configuração válida
// e é reiniciado (sem derrubar o serviço) quando a configuração muda pelo Monitor.
async function runService(configPath: string, flags: Record<string, string>) {
  let agent: Agent | null = null;
  let cfg: AgentConfig | null = null;
  let cfgError: string | null = null;
  let stopping = false;
  let wake: (() => void) | null = null;
  const baseLog = () => new Logger(cfg?.dataDir ?? defaultDataDir(), cfg?.logLevel ?? 'info', true);

  const host: MonitorHost = {
    agent: () => agent,
    currentConfig: () => cfg && {
      serverUrl: cfg.serverUrl,
      hasToken: !!cfg.deviceToken,
      printer: { mode: cfg.printer.mode, windowsName: cfg.printer.windowsName, host: cfg.printer.host, port: cfg.printer.port },
    },
    configError: () => cfgError,
    logTail: (n) => tailLog(cfg?.dataDir ?? defaultDataDir(), n),
    saveConfig: async (setup: MonitorSetup) => {
      writeConfig(configPath, {
        serverUrl: setup.serverUrl,
        deviceToken: setup.deviceToken,
        printer: { mode: setup.printer.mode, windowsName: setup.printer.windowsName ?? '', host: setup.printer.host ?? '', port: setup.printer.port ?? 9100 },
      });
      baseLog().info('Configuração alterada pelo Monitor de Impressão; reconectando.');
      agent?.stop();
      wake?.();
    },
  };

  const stop = () => {
    stopping = true;
    agent?.stop();
    wake?.();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGBREAK' as NodeJS.Signals, stop);

  // Atualização automática: a versão em uso confirma que funciona assim que conecta; de tempos em tempos
  // pergunta ao servidor se há versão nova, baixa e reinicia o serviço (o Windows o sobe de novo em 10 s).
  let restartForUpdate = false;
  const autoUpdate = process.env.RANGASSO_NO_AUTO_UPDATE !== '1';
  const healthTimer = setInterval(() => {
    if (cfg && agent?.connection.ok) markHealthy(cfg.dataDir, AGENT_VERSION);
  }, 15_000);
  healthTimer.unref();
  const checkUpdate = async () => {
    if (!autoUpdate || !cfg || stopping || !agent?.connection.ok) return;
    if (!/^https:\/\//.test(cfg.serverUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(cfg.serverUrl)) return;
    const api = new AgentApi(cfg.serverUrl, cfg.deviceToken, AGENT_VERSION);
    try {
      const v = await downloadUpdate({ latest: () => api.updateInfo(), download: () => api.downloadUpdate() }, cfg.dataDir, AGENT_VERSION);
      if (v && !stopping) {
        baseLog().info(`Atualização ${v} baixada (versão atual ${AGENT_VERSION}). Reiniciando o serviço para aplicar.`);
        restartForUpdate = true;
        stop();
      }
    } catch (e) {
      baseLog().warn('Não foi possível verificar atualização do agente.', e);
    }
  };
  const firstCheck = setTimeout(() => void checkUpdate(), UPDATE_FIRST_CHECK_MS);
  const updateTimer = setInterval(() => void checkUpdate(), UPDATE_EVERY_MS);
  firstCheck.unref();
  updateTimer.unref();

  let monitor: Awaited<ReturnType<typeof startMonitor>> | null = null;
  if (flags['no-monitor'] !== 'true') {
    const port = Number(flags['monitor-port'] ?? process.env.RANGASSO_MONITOR_PORT ?? MONITOR_PORT);
    try {
      monitor = await startMonitor(host, port);
      baseLog().info(`Monitor de Impressão em http://127.0.0.1:${port}`);
    } catch (e) {
      baseLog().warn(`Monitor de Impressão não iniciou (porta ${port} ocupada?). O agente segue funcionando.`, e);
    }
  }

  while (!stopping) {
    try {
      cfg = loadConfig(configPath);
      cfgError = null;
    } catch (e) {
      cfg = null;
      cfgError = existsSync(configPath) ? (e as Error).message : null;
    }
    if (!cfg) {
      baseLog().warn(`Agente aguardando configuração. Abra http://127.0.0.1:${MONITOR_PORT} neste computador.${cfgError ? ` (${cfgError})` : ''}`);
      // Espera o Monitor salvar a configuração (ou alguém editar o arquivo), checando a cada 30 s.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 30_000);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      wake = null;
      continue;
    }
    agent = new Agent(cfg, new Logger(cfg.dataDir, cfg.logLevel, true));
    await agent.run();
  }
  clearInterval(healthTimer);
  clearInterval(updateTimer);
  clearTimeout(firstCheck);
  monitor?.close();
  if (restartForUpdate) process.exit(RESTART_FOR_UPDATE_EXIT_CODE);
}

async function main() {
  const { flags, rest } = args(process.argv.slice(2));
  const cmd = rest[0] ?? 'help';
  const configPath = flags.config ? path.resolve(flags.config) : defaultConfigPath();

  if (cmd === 'help' || flags.help) return void console.log(HELP);
  if (cmd === 'version') return void console.log(AGENT_VERSION);

  if (cmd === 'setup') {
    const patch: ConfigPatch = { serverUrl: flags.server, deviceToken: flags.token, printer: {} };
    if (flags.printer) patch.printer!.mode = flags.printer;
    if (flags['windows-name']) patch.printer!.windowsName = flags['windows-name'];
    if (flags.host) patch.printer!.host = flags.host;
    if (flags.port) patch.printer!.port = Number(flags.port);
    if (flags.columns) patch.printer!.columns = Number(flags.columns);
    if (flags['output-dir']) patch.printer!.outputDir = flags['output-dir'];
    try {
      writeConfig(configPath, patch);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 2;
      return;
    }
    console.log(`Configuração gravada em ${configPath}`);
    return;
  }

  if (cmd === 'list-printers') {
    const list = await listWindowsPrinters();
    if (!list.length) console.log('Nenhuma impressora encontrada (ou não é Windows).');
    for (const p of list) console.log(`- ${p.name}${p.default ? ' (padrão)' : ''}  porta: ${p.port ?? '?'}  driver: ${p.driver ?? '?'}`);
    return;
  }

  if (cmd === 'run') return runService(configPath, flags);

  const cfg = loadConfig(configPath);

  if (cmd === 'test-connection') {
    const api = new AgentApi(cfg.serverUrl, cfg.deviceToken, AGENT_VERSION);
    const agent = new Agent(cfg, new Logger(cfg.dataDir, 'warn', true), { api });
    try {
      const r = await agent.heartbeat();
      console.log(`OK: conectado como "${r.device.name}". Hora do servidor: ${r.serverTime}`);
      console.log(`Impressora no painel: ${r.printer.connection} ${r.printer.connection === 'network' ? `${r.printer.host}:${r.printer.port}` : r.printer.windowsName || '(nome não informado)'} · ${r.printer.columns} colunas`);
    } catch (e) {
      console.error(`FALHOU: ${(e as Error).message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === 'test-print' || cmd === 'status' || cmd === 'preview') {
    const agent = new Agent(cfg, new Logger(cfg.dataDir, 'warn', true));
    // Em modo auto, busca a configuração do painel antes de escolher a impressora.
    if (cfg.printer.mode === 'auto') {
      try {
        await agent.heartbeat();
      } catch (e) {
        console.error(`Aviso: não foi possível ler a configuração do painel (${(e as Error).message}).`);
      }
    }
    const columns = cfg.printer.columns || agent.columns();
    if (cmd === 'preview') return void console.log(renderText(testPayload(cfg, columns), { kind: 'test', reprintNumber: 0, copies: 1 }));
    let printer;
    try {
      printer = agent.resolvePrinter();
    } catch (e) {
      console.error(`Impressora não definida: ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
    if (cmd === 'status') {
      const st = await printer.status();
      const j = new Journal(cfg.dataDir);
      console.log(`Versão: ${AGENT_VERSION}\nConfig: ${cfg.configPath}\nDados/logs: ${cfg.dataDir}\nServidor: ${cfg.serverUrl}`);
      console.log(`Impressora: ${printer.mode} → ${printer.target} · ${columns} colunas`);
      console.log(`Estado: ${st.online === true ? 'online' : st.online === false ? 'OFFLINE' : 'não informado pelo driver'}${st.error ? ` · ${st.error}` : ''}`);
      console.log(`Avisos pendentes para o servidor: ${j.outbox.length}`);
      return;
    }
    try {
      const r = await printer.print(renderEscPos(testPayload(cfg, columns), { kind: 'test', reprintNumber: 0, copies: 1 }), 'rangasso-teste');
      console.log(`${r.outcome === 'printed' ? 'Impresso (confirmado pela impressora)' : 'Enviado à impressora'}: ${r.detail}`);
      console.log('Confira se o papel saiu com os acentos corretos e cortado.');
    } catch (e) {
      console.error(`FALHOU: ${(e as Error).message}`);
      process.exitCode = 1;
    }
    return;
  }

  console.error(`Comando desconhecido: ${cmd}\n`);
  console.log(HELP);
  process.exitCode = 2;
}

// Serviço com atualização baixada: carrega a versão nova (que roda o próprio main) em vez desta.
function loadDownloadedUpdate(): boolean {
  const { flags, rest } = args(process.argv.slice(2));
  if (rest[0] !== 'run' || process.env.RANGASSO_UPDATE_LOADED || process.env.RANGASSO_NO_AUTO_UPDATE === '1') return false;
  let dataDir = defaultDataDir();
  try {
    dataDir = loadConfig(flags.config ? path.resolve(flags.config) : defaultConfigPath()).dataDir;
  } catch {
    // sem configuração: usa a pasta padrão
  }
  try {
    const file = pickUpdate(dataDir, AGENT_VERSION);
    if (!file) return false;
    process.env.RANGASSO_UPDATE_LOADED = AGENT_VERSION;
    require(file);
    return true;
  } catch (e) {
    console.error(`Atualização baixada não carregou; usando a versão instalada ${AGENT_VERSION}: ${(e as Error).message}`);
    return false;
  }
}

if (!loadDownloadedUpdate()) {
  main().catch((e) => {
    console.error(`Erro: ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
