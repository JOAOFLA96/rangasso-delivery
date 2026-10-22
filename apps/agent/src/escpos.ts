import iconv from 'iconv-lite';

// Montador mínimo de comandos ESC/POS compatível com a linha Epson TM-T20.
// Texto em CP860 (português), selecionado com ESC t 3.

const ESC = 0x1b;
const GS = 0x1d;

// Troca caracteres que não existem na CP860 por equivalentes legíveis.
const REPLACEMENTS: [RegExp, string][] = [
  [/[‘’´`]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—]/g, '-'],
  [/…/g, '...'],
  [/ /g, ' '],
  [/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}️]/gu, ''],
];
export function sanitize(text: string) {
  let t = text.normalize('NFC');
  for (const [re, rep] of REPLACEMENTS) t = t.replace(re, rep);
  return t.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
}

export class EscPos {
  private chunks: Buffer[] = [];

  constructor() {
    this.raw([ESC, 0x40]); // inicializa
    this.raw([ESC, 0x74, 3]); // tabela de caracteres PC860 (português)
  }

  raw(bytes: number[] | Buffer) {
    this.chunks.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    return this;
  }

  text(s: string) {
    return this.raw(iconv.encode(sanitize(s), 'cp860'));
  }

  line(s = '') {
    return this.text(s).raw([0x0a]);
  }

  align(a: 'left' | 'center' | 'right') {
    return this.raw([ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2]);
  }

  bold(on: boolean) {
    return this.raw([ESC, 0x45, on ? 1 : 0]);
  }

  invert(on: boolean) {
    return this.raw([GS, 0x42, on ? 1 : 0]);
  }

  // width/height: 1 = normal, 2 = dobrado
  size(width: 1 | 2, height: 1 | 2) {
    return this.raw([GS, 0x21, ((width - 1) << 4) | (height - 1)]);
  }

  feed(lines: number) {
    return this.raw([ESC, 0x64, Math.max(0, Math.min(255, lines))]);
  }

  // Avança o papel e faz corte parcial (GS V 66 n).
  cut() {
    return this.raw([GS, 0x56, 66, 3]);
  }

  build() {
    return Buffer.concat(this.chunks);
  }
}

// Utilidades de texto monoespaçado.
export function wrap(text: string, width: number, indent = ''): string[] {
  const out: string[] = [];
  for (const para of sanitize(text).split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (w.length > width - indent.length) {
        // palavra maior que a linha: quebra à força
        if (line) out.push(line), (line = '');
        out.push((out.length && indent ? indent : '') + w.slice(0, width - indent.length));
        w = w.slice(width - indent.length);
      }
      const candidate = line ? `${line} ${w}` : (out.length && indent ? indent : '') + w;
      if (candidate.length > width) {
        out.push(line);
        line = indent + w;
      } else line = candidate;
    }
    if (line) out.push(line);
  }
  return out;
}

export function leftRight(left: string, right: string, width: number): string[] {
  const l = sanitize(left);
  const r = sanitize(right);
  if (l.length + 1 + r.length <= width) return [l + ' '.repeat(width - l.length - r.length) + r];
  // quebra o texto da esquerda e coloca o valor na última linha
  const lines = wrap(l, width - r.length - 1);
  const last = lines.pop() ?? '';
  return [...lines, last + ' '.repeat(width - last.length - r.length) + r];
}

export const rule = (width: number, ch = '-') => ch.repeat(width);
