import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';

// Diário local persistente. Garante que, após queda de energia ou reinício do Windows, o agente
// saiba o que já imprimiu, o que estava no meio da impressão e quais avisos ainda não chegaram ao servidor.

export type ReportStatus = 'sending' | 'sent' | 'printed' | 'failed' | 'uncertain';
export interface ClaimEntry { jobId: string; state: 'sending' | 'done'; outcome?: ReportStatus; at: string; label: string }
export interface OutboxEntry { jobId: string; status: ReportStatus; detail: string; at: string; tries: number }
interface State { claims: Record<string, ClaimEntry>; outbox: OutboxEntry[] }

export class Journal {
  private file: string;
  private state: State = { claims: {}, outbox: [] };

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'state.json');
    if (existsSync(this.file)) {
      try {
        this.state = JSON.parse(readFileSync(this.file, 'utf8'));
        this.state.claims ??= {};
        this.state.outbox ??= [];
      } catch {
        // Arquivo corrompido: guarda cópia para análise e começa limpo (o servidor também protege contra duplicação).
        renameSync(this.file, `${this.file}.corrompido-${Date.now()}`);
      }
    }
    this.prune();
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    const fd = openSync(tmp, 'r');
    try {
      fsyncSync(fd);
    } catch {
      /* fsync indisponível em alguns sistemas de arquivos */
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
  }

  private prune() {
    const limit = Date.now() - 7 * 86400_000;
    for (const [k, v] of Object.entries(this.state.claims)) if (v.state === 'done' && Date.parse(v.at) < limit) delete this.state.claims[k];
  }

  get(claimKey: string) {
    return this.state.claims[claimKey];
  }

  markSending(claimKey: string, jobId: string, label: string) {
    this.state.claims[claimKey] = { jobId, state: 'sending', at: new Date().toISOString(), label };
    this.save();
  }

  markDone(claimKey: string, outcome: ReportStatus) {
    const e = this.state.claims[claimKey];
    if (e) {
      e.state = 'done';
      e.outcome = outcome;
      e.at = new Date().toISOString();
    }
    this.save();
  }

  forget(claimKey: string) {
    delete this.state.claims[claimKey];
    this.save();
  }

  // Trabalhos que estavam "imprimindo" quando o agente parou: resultado incerto.
  interrupted(): [string, ClaimEntry][] {
    return Object.entries(this.state.claims).filter(([, v]) => v.state === 'sending');
  }

  enqueue(entry: Omit<OutboxEntry, 'at' | 'tries'>) {
    this.state.outbox.push({ ...entry, at: new Date().toISOString(), tries: 0 });
    this.save();
  }

  get outbox() {
    return this.state.outbox;
  }

  removeOutbox(e: OutboxEntry) {
    this.state.outbox = this.state.outbox.filter((x) => x !== e);
    this.save();
  }

  touchOutbox(e: OutboxEntry) {
    e.tries += 1;
    this.save();
  }
}
