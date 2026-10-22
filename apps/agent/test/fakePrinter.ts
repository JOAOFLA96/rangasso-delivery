import net from 'node:net';

// Impressora ESC/POS simulada em TCP (porta 9100 virtual). Responde a DLE EOT 1/2/4 como uma TM-T20
// e guarda tudo o que recebe, para os testes conferirem o que "saiu no papel".
export class FakeNetworkPrinter {
  server = net.createServer((s) => this.onConn(s));
  received: Buffer[] = [];
  state = { offline: false, paperOut: false, coverOpen: false, silent: false, dropAfterData: false, holdAfterDataMs: 0 };
  onData?: () => void;
  port = 0;

  async start() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }
  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
  private onConn(sock: net.Socket) {
    let buf = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      let i;
      while ((i = buf.indexOf(Buffer.from([0x10, 0x04]))) >= 0 && buf.length >= i + 3) {
        const n = buf[i + 2];
        const before = buf.subarray(0, i);
        let hold = 0;
        if (before.length) {
          this.received.push(Buffer.from(before));
          this.onData?.();
          if (this.state.dropAfterData) return sock.destroy();
          hold = this.state.holdAfterDataMs;
        }
        buf = buf.subarray(i + 3);
        if (this.state.silent) continue;
        const byte = Buffer.from([this.statusByte(n)]);
        if (hold) setTimeout(() => !sock.destroyed && sock.write(byte), hold);
        else sock.write(byte);
      }
    });
    sock.on('end', () => {
      if (buf.length) this.received.push(Buffer.from(buf));
    });
  }
  private statusByte(n: number) {
    const s = this.state;
    if (n === 1) return 0x16 | (s.offline || s.paperOut || s.coverOpen ? 0x08 : 0);
    if (n === 2) return 0x12 | (s.coverOpen ? 0x04 : 0) | (s.paperOut ? 0x20 : 0);
    if (n === 4) return 0x12 | (s.paperOut ? 0x60 : 0);
    return 0x12;
  }
  // Quantas comandas (cortes) chegaram.
  cuts() {
    const all = Buffer.concat(this.received);
    let c = 0;
    for (let i = 0; i < all.length - 3; i++) if (all[i] === 0x1d && all[i + 1] === 0x56 && all[i + 2] === 66) c++;
    return c;
  }
}
