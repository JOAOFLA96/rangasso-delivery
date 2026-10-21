import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrinterError, type Printer, type PrintResult, type PrinterStatus } from './types.js';

// Impressão pelo spooler do Windows (USB, porta virtual serial/USB, ou compartilhada), em modo RAW.
// O Windows só confirma que aceitou o trabalho; não há confirmação física do papel pela USB.

export function findScriptsDir(): string {
  const base = path.dirname(process.argv[1] ?? '.');
  for (const c of [path.join(base, 'scripts'), path.join(base, '..', 'windows'), path.join(process.cwd(), 'windows')]) {
    if (existsSync(path.join(c, 'raw-print.ps1'))) return c;
  }
  return path.join(base, 'scripts');
}

function powershell(script: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? ((err as any).code ?? 1) : 0;
        resolve({ code: typeof code === 'number' ? code : 1, out: `${stdout}`.trim() || `${stderr}`.trim() || (err?.message ?? ''), timedOut: !!(err as any)?.killed });
      },
    );
  });
}

const ERROR_STATES: Record<number, string> = {
  3: 'Pouco papel', 4: 'Sem papel', 7: 'Tampa aberta', 8: 'Papel enroscado', 9: 'Impressora offline', 10: 'Precisa de manutenção',
};

export class WindowsPrinter implements Printer {
  readonly mode = 'windows';
  constructor(private name: string, private tmpDir: string, private scriptsDir = findScriptsDir()) {}
  get target() {
    return this.name;
  }

  async status(): Promise<PrinterStatus> {
    if (process.platform !== 'win32') return { online: null, error: 'Modo Windows só funciona no Windows.' };
    const r = await powershell(path.join(this.scriptsDir, 'printer-status.ps1'), ['-PrinterName', this.name], 20_000);
    try {
      const j = JSON.parse(r.out);
      if (!j.found) return { online: false, error: j.error ?? `Impressora "${this.name}" não encontrada no Windows.` };
      const des = Number(j.detectedErrorState ?? 0);
      const offline = j.workOffline === true || des === 9;
      return {
        online: offline ? false : des === 2 || des === 0 ? null : !ERROR_STATES[des],
        paperOut: des === 4 ? true : null,
        coverOpen: des === 7 ? true : null,
        error: ERROR_STATES[des] ?? (offline ? 'Impressora offline' : null),
      };
    } catch {
      return { online: null, error: `Não foi possível ler o estado: ${r.out.slice(0, 200)}` };
    }
  }

  async print(data: Buffer, docName: string): Promise<PrintResult> {
    if (process.platform !== 'win32') throw new PrinterError('Modo Windows só funciona no Windows.');
    if (!this.name) throw new PrinterError('Nome da impressora no Windows não configurado.');
    await mkdir(this.tmpDir, { recursive: true });
    const file = path.join(this.tmpDir, `${randomUUID()}.bin`);
    await writeFile(file, data);
    try {
      const r = await powershell(path.join(this.scriptsDir, 'raw-print.ps1'), ['-PrinterName', this.name, '-Path', file, '-DocName', docName], 60_000);
      let j: any = null;
      try {
        j = JSON.parse(r.out.split(/\r?\n/).pop() ?? '');
      } catch {
        /* saída inesperada */
      }
      if (r.code === 0 && j?.ok) return { outcome: 'sent', detail: `Spooler do Windows aceitou (trabalho ${j.spoolJobId}, ${j.bytes} bytes).` };
      // Tempo esgotado ou falha no meio da gravação: o spooler pode ter recebido parte dos dados.
      if (r.timedOut) throw new PrinterError('O Windows demorou demais para aceitar a comanda. Confira se ela saiu.', false);
      if (j?.error && /WritePrinter|EndDocPrinter/.test(j.error)) throw new PrinterError(`Falha durante o envio ao spooler: ${j.error}`, false);
      // Falha antes de o spooler aceitar (impressora não encontrada, sem permissão): nada foi impresso, pode tentar de novo.
      throw new PrinterError(j?.error ?? `Falha no envio ao Windows: ${r.out.slice(0, 300)}`);
    } finally {
      await unlink(file).catch(() => {});
    }
  }
}

export async function listWindowsPrinters(scriptsDir = findScriptsDir()) {
  if (process.platform !== 'win32') return [];
  const r = await powershell(path.join(scriptsDir, 'printer-status.ps1'), ['-List'], 20_000);
  try {
    const j = JSON.parse(r.out);
    return Array.isArray(j) ? j : [j];
  } catch {
    return [];
  }
}
