import { appendFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

// Log em arquivo diário (logs/agent-AAAA-MM-DD.log), mantido por 14 dias. Não registra dados de clientes.
export class Logger {
  private dir: string;
  constructor(dataDir: string, private level: Level = 'info', private toConsole = true) {
    this.dir = path.join(dataDir, 'logs');
    try {
      mkdirSync(this.dir, { recursive: true });
      this.prune();
    } catch {
      /* sem pasta de log: segue só no console */
    }
  }
  private prune() {
    const limit = Date.now() - 14 * 86400_000;
    for (const f of readdirSync(this.dir)) {
      const p = path.join(this.dir, f);
      if (f.startsWith('agent-') && statSync(p).mtimeMs < limit) unlinkSync(p);
    }
  }
  private write(level: Level, msg: string, extra?: unknown) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${extra !== undefined ? ' ' + (extra instanceof Error ? extra.message : JSON.stringify(extra)) : ''}`;
    if (this.toConsole) (level === 'error' || level === 'warn' ? console.error : console.log)(line);
    try {
      appendFileSync(path.join(this.dir, `agent-${new Date().toISOString().slice(0, 10)}.log`), line + '\n');
    } catch {
      /* disco cheio ou sem permissão: não derruba o agente */
    }
  }
  debug = (m: string, e?: unknown) => this.write('debug', m, e);
  info = (m: string, e?: unknown) => this.write('info', m, e);
  warn = (m: string, e?: unknown) => this.write('warn', m, e);
  error = (m: string, e?: unknown) => this.write('error', m, e);
}
