import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Printer, PrintResult, PrinterStatus } from './types.js';

// "Impressora" de arquivo, para teste/homologação sem hardware: grava os bytes ESC/POS em disco.
export class FilePrinter implements Printer {
  readonly mode = 'file';
  constructor(private dir: string) {}
  get target() {
    return this.dir;
  }
  async status(): Promise<PrinterStatus> {
    return { online: true, error: null };
  }
  async print(data: Buffer, docName: string): Promise<PrintResult> {
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${docName.replace(/[^\w.-]+/g, '_')}.bin`);
    await writeFile(file, data);
    return { outcome: 'sent', detail: `Gravado em ${file}` };
  }
}
