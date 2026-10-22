import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface AgentConfig {
  serverUrl: string;
  deviceToken: string;
  printer: {
    // auto: usa o que estiver configurado no painel (Configurações > Impressora)
    mode: 'auto' | 'windows' | 'network' | 'file';
    windowsName: string;
    host: string;
    port: number;
    columns: number; // 0 = usa o do painel
    outputDir: string; // modo file
  };
  dataDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  configPath: string;
}

export function defaultDataDir() {
  if (process.platform === 'win32') return path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'RangassoAgent');
  return path.resolve('data');
}

export function defaultConfigPath() {
  const candidates = [
    path.join(defaultDataDir(), 'config.json'),
    path.join(path.dirname(process.argv[1] ?? '.'), 'config.json'),
    path.resolve('config.json'),
  ];
  return candidates.find((c) => existsSync(c)) ?? candidates[0];
}

// Aceita o endereço copiado de qualquer página do sistema (ex.: .../admin ou .../cardapio) e usa só a origem.
export function normalizeServerUrl(raw: string): string {
  const v = raw.trim();
  try {
    const u = new URL(v);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
  } catch {
    /* inválido: a validação abaixo explica o problema */
  }
  return v.replace(/\/+$/, '');
}

export function loadConfig(configPath = defaultConfigPath()): AgentConfig {
  if (!existsSync(configPath)) throw new Error(`Arquivo de configuração não encontrado: ${configPath}`);
  const raw = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  const p = raw.printer ?? {};
  const cfg: AgentConfig = {
    serverUrl: normalizeServerUrl(String(raw.serverUrl ?? '')),
    deviceToken: String(raw.deviceToken ?? '').trim(),
    printer: {
      mode: ['auto', 'windows', 'network', 'file'].includes(p.mode) ? p.mode : 'auto',
      windowsName: String(p.windowsName ?? ''),
      host: String(p.host ?? ''),
      port: Number(p.port) || 9100,
      columns: [32, 42, 48].includes(Number(p.columns)) ? Number(p.columns) : 0,
      outputDir: String(p.outputDir ?? ''),
    },
    dataDir: raw.dataDir ? String(raw.dataDir) : defaultDataDir(),
    logLevel: ['debug', 'info', 'warn', 'error'].includes(raw.logLevel) ? raw.logLevel : 'info',
    configPath,
  };
  const problems: string[] = [];
  if (!/^https?:\/\//.test(cfg.serverUrl)) problems.push('serverUrl precisa começar com https://');
  if (cfg.serverUrl.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(cfg.serverUrl)) problems.push('use https:// no serverUrl (http só é aceito para localhost)');
  if (!/^rgd_[A-Za-z0-9_-]{20,80}$/.test(cfg.deviceToken)) problems.push('deviceToken ausente ou inválido (copie a chave criada no painel)');
  if (cfg.printer.mode === 'network' && !cfg.printer.host) problems.push('printer.host é obrigatório no modo network');
  if (cfg.printer.mode === 'windows' && !cfg.printer.windowsName) problems.push('printer.windowsName é obrigatório no modo windows');
  if (cfg.printer.mode === 'file' && !cfg.printer.outputDir) problems.push('printer.outputDir é obrigatório no modo file');
  if (problems.length) throw new Error(`Configuração inválida em ${configPath}: ${problems.join('; ')}`);
  return cfg;
}
