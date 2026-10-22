import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Agent, AGENT_VERSION } from './agent.js';
import { AgentApi } from './api.js';
import { defaultConfigPath, defaultDataDir, loadConfig, type AgentConfig } from './config.js';
import { Journal } from './journal.js';
import { Logger } from './logger.js';
import { listWindowsPrinters } from './printers/windows.js';
import { renderEscPos, renderText, type ReceiptPayload } from './receipt.js';

const HELP = `Agente de impressão Rangasso ${AGENT_VERSION}

Uso: rangasso-agent <comando> [--config caminho\\config.json]

Comandos:
  run               Inicia o agente (é o que o serviço do Windows executa)
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

async function main() {
  const { flags, rest } = args(process.argv.slice(2));
  const cmd = rest[0] ?? 'help';
  const configPath = flags.config ? path.resolve(flags.config) : defaultConfigPath();

  if (cmd === 'help' || flags.help) return void console.log(HELP);
  if (cmd === 'version') return void console.log(AGENT_VERSION);

  if (cmd === 'setup') {
    let current: any = {};
    if (existsSync(configPath)) current = JSON.parse(readFileSync(configPath, 'utf8').replace(/^﻿/, ''));
    const printer = { mode: 'auto', windowsName: '', host: '', port: 9100, columns: 0, outputDir: '', ...(current.printer ?? {}) };
    if (flags.printer) printer.mode = flags.printer;
    if (flags['windows-name']) printer.windowsName = flags['windows-name'];
    if (flags.host) printer.host = flags.host;
    if (flags.port) printer.port = Number(flags.port);
    if (flags.columns) printer.columns = Number(flags.columns);
    if (flags['output-dir']) printer.outputDir = flags['output-dir'];
    const next = {
      serverUrl: flags.server ?? current.serverUrl ?? '',
      deviceToken: flags.token ?? current.deviceToken ?? '',
      printer,
      dataDir: current.dataDir ?? defaultDataDir(),
      logLevel: current.logLevel ?? 'info',
    };
    mkdirSync(path.dirname(configPath), { recursive: true });
    const tmp = configPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    // valida antes de substituir
    try {
      loadConfig(tmp);
    } catch (e) {
      console.error((e as Error).message.replace(tmp, configPath));
      process.exitCode = 2;
      return;
    }
    writeFileSync(configPath, JSON.stringify(next, null, 2));
    rmSync(tmp, { force: true });
    console.log(`Configuração gravada em ${configPath}`);
    return;
  }

  if (cmd === 'list-printers') {
    const list = await listWindowsPrinters();
    if (!list.length) console.log('Nenhuma impressora encontrada (ou não é Windows).');
    for (const p of list) console.log(`- ${p.name}${p.default ? ' (padrão)' : ''}  porta: ${p.port ?? '?'}  driver: ${p.driver ?? '?'}`);
    return;
  }

  const cfg = loadConfig(configPath);
  const log = new Logger(cfg.dataDir, cfg.logLevel, true);

  if (cmd === 'run') {
    const agent = new Agent(cfg, log);
    const stop = () => agent.stop();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('SIGBREAK' as NodeJS.Signals, stop);
    await agent.run();
    return;
  }

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

main().catch((e) => {
  console.error(`Erro: ${(e as Error).message}`);
  process.exitCode = 1;
});
