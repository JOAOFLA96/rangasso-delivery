import net from 'node:net';
import { PrinterError, type Printer, type PrintResult, type PrinterStatus } from './types.js';

// Impressora em rede (Ethernet), porta RAW 9100. Usa DLE EOT para ler o estado real da impressora.
// Só vale para variantes da TM-T20 com interface Ethernet.

const DLE = 0x10;
const EOT = 0x04;

function connect(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    const t = setTimeout(() => {
      sock.destroy();
      reject(new PrinterError(`Impressora ${host}:${port} não respondeu (tempo esgotado). Confira cabo, IP e se está ligada.`));
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(t);
      resolve(sock);
    });
    sock.once('error', (e) => {
      clearTimeout(t);
      reject(new PrinterError(`Sem conexão com a impressora ${host}:${port}: ${e.message}`));
    });
  });
}

function query(sock: net.Socket, n: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      sock.off('data', onData);
      resolve(null);
    }, timeoutMs);
    const onData = (d: Buffer) => {
      clearTimeout(t);
      sock.off('data', onData);
      resolve(d[d.length - 1]);
    };
    sock.on('data', onData);
    sock.write(Buffer.from([DLE, EOT, n]));
  });
}

async function readStatus(sock: net.Socket): Promise<PrinterStatus> {
  const printer = await query(sock, 1, 1500); // estado da impressora
  if (printer === null) return { online: null, error: 'A impressora não respondeu à consulta de estado.' };
  const offline = await query(sock, 2, 1500); // causa de offline
  const paper = await query(sock, 4, 1500); // sensor de papel
  const coverOpen = offline !== null ? (offline & 0x04) !== 0 : null;
  const paperOut = paper !== null ? (paper & 0x60) === 0x60 : null;
  const isOffline = (printer & 0x08) !== 0;
  const errorBits = offline !== null && (offline & 0x40) !== 0;
  return {
    online: !isOffline,
    paperOut,
    coverOpen,
    error: paperOut ? 'Sem papel' : coverOpen ? 'Tampa aberta' : errorBits ? 'Erro na impressora' : isOffline ? 'Impressora offline' : null,
  };
}

export class NetworkPrinter implements Printer {
  readonly mode = 'network';
  constructor(private host: string, private port = 9100) {}
  get target() {
    return `${this.host}:${this.port}`;
  }

  async status(): Promise<PrinterStatus> {
    let sock: net.Socket | null = null;
    try {
      sock = await connect(this.host, this.port, 4000);
      sock.on('error', () => {});
      return await readStatus(sock);
    } catch (e) {
      return { online: false, error: (e as Error).message };
    } finally {
      sock?.destroy();
    }
  }

  async print(data: Buffer): Promise<PrintResult> {
    const sock = await connect(this.host, this.port, 5000);
    sock.on('error', () => {}); // erros aparecem como falta de resposta; tratados abaixo
    try {
      const before = await readStatus(sock);
      if (before.online === false || before.paperOut || before.coverOpen) {
        throw new PrinterError(before.error ?? 'Impressora indisponível.');
      }
      await new Promise<void>((resolve, reject) => {
        sock.write(data, (err) => (err ? reject(new PrinterError(`Falha ao enviar: ${err.message}`, false)) : resolve()));
      });
      // Depois do envio, consulta de novo: se a impressora responde OK, consideramos impresso.
      const after = sock.destroyed ? { online: null, error: 'conexão encerrada' } as PrinterStatus : await readStatus(sock);
      if (after.online && !after.paperOut && !after.coverOpen) return { outcome: 'printed', detail: 'Impressora confirmou estado OK após o envio.' };
      if (after.online === null) {
        // Respondia antes e parou de responder depois do envio (conexão caiu, travou): não dá para saber se saiu.
        if (before.online !== null || sock.destroyed) throw new PrinterError('A conexão com a impressora caiu logo após o envio. Confira se a comanda saiu.', false);
        return { outcome: 'sent', detail: 'Dados enviados; esta impressora não informa estado.' };
      }
      // Enviado, mas a impressora reportou problema: pode ter saído parcialmente.
      throw new PrinterError(`Enviado, mas a impressora reportou: ${after.error}. Confira a comanda.`, false);
    } finally {
      sock.end();
      sock.destroy();
    }
  }
}
