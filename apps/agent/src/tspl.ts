import { labelDate, type LabelPayload } from './receipt.js';

// Etiqueta de validade em TSPL (impressoras térmicas de etiqueta: Elgin, Argox, Xprinter, OIA e similares, 203 dpi).
// SIZE + GAP fazem a impressora usar o sensor de espaço: cada etiqueta começa no início da próxima, sem "andar".
// Texto com as fontes internas da impressora (sem acento: as fontes de fábrica dos modelos genéricos não têm).

export interface TsplSettings {
  printerName: string;
  widthMm: number;
  heightMm: number;
  gapMm: number;
  speed: number; // pol/s (1 a 6). Menor = mais nítido.
  density: number; // 0 a 15. Maior = mais escuro.
  offsetXmm: number;
  offsetYmm: number;
  rotate: boolean; // DIRECTION 0 em vez de 1
}

export interface TsplPayload {
  store: { name: string; timezone?: string };
  label?: LabelPayload;
  calibration?: boolean;
  tspl: TsplSettings;
}

const DOTS_PER_MM = 8; // 203 dpi
const TYPE: Record<string, string> = { handled: 'MANIPULADO', opened: 'ABERTO', thawing: 'DESCONGELANDO', sample: 'AMOSTRA' };
const STORAGE: Record<string, string> = { chilled: 'RESFRIADO ATE 5C', frozen: 'CONGELADO -18C', ambient: 'AMBIENTE' };
// Largura em pontos de cada fonte interna (fonte "1" 8x12, "2" 12x20, "3" 16x24).
const FONT_W: Record<string, number> = { '1': 8, '2': 12, '3': 16 };

// Sem acento, sem aspas (delimitam o texto no TSPL) e só ASCII imprimível.
export function plain(s: string) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ç/gi, (c) => (c === 'ç' ? 'c' : 'C'))
    .replace(/°/g, '')
    .replace(/["“”]/g, "'")
    .replace(/[^\x20-\x7e]/g, '')
    .trim();
}

function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const word = w.length > max ? w.slice(0, max) : w;
    if (!line) line = word;
    else if (line.length + 1 + word.length <= max) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

const clamp = (n: number, min: number, max: number, def: number) => (Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def);

export function renderTspl(p: TsplPayload, copies = 1): Buffer {
  const t = p.tspl;
  const w = clamp(t.widthMm, 20, 104, 50);
  const h = clamp(t.heightMm, 15, 200, 30);
  const ox = Math.round(clamp(t.offsetXmm, -10, 10, 0) * DOTS_PER_MM);
  const oy = Math.round(clamp(t.offsetYmm, -10, 10, 0) * DOTS_PER_MM);
  const wd = w * DOTS_PER_MM;
  const margin = 12;
  const usable = wd - 2 * margin;
  const cols = (font: string) => Math.floor(usable / FONT_W[font]);
  const lines: string[] = [
    `SIZE ${w} mm,${h} mm`,
    `GAP ${clamp(t.gapMm, 0, 20, 4)} mm,0 mm`,
    `SPEED ${clamp(Math.round(t.speed), 1, 6, 3)}`,
    `DENSITY ${clamp(Math.round(t.density), 0, 15, 10)}`,
    `DIRECTION ${t.rotate ? 0 : 1}`,
    'REFERENCE 0,0',
    'SET TEAR ON',
    'CLS',
  ];
  const text = (x: number, y: number, font: string, s: string) => lines.push(`TEXT ${x + ox},${y + oy},"${font}",0,1,1,"${plain(s).slice(0, cols(font))}"`);
  const x = margin;

  if (p.calibration || !p.label) {
    lines.push(`BOX ${4 + ox},${4 + oy},${wd - 4 + ox},${h * DOTS_PER_MM - 4 + oy},3`);
    text(x + 4, 16, '3', `TESTE ${w}x${h} mm`);
    text(x + 4, 52, '2', 'A moldura deve ficar inteira');
    text(x + 4, 78, '2', 'e igual em todas.');
    text(x + 4, 110, '2', `SPEED ${clamp(Math.round(t.speed), 1, 6, 3)}  DENSITY ${clamp(Math.round(t.density), 0, 15, 10)}`);
    text(x + 4, 136, '2', `GAP ${clamp(t.gapMm, 0, 20, 4)} mm`);
  } else {
    const l = p.label;
    const tz = p.store.timezone;
    const name = wrap(plain(l.productName.toUpperCase()), cols('3')).slice(0, 2);
    let y = 8;
    for (const n of name) {
      text(x, y, '3', n);
      y += 26;
    }
    if (name.length < 2) y += 4;
    const band = `${TYPE[l.labelType] ?? l.labelType} - ${STORAGE[l.storage] ?? l.storage}`;
    text(x + 4, y + 2, '2', band);
    lines.push(`REVERSE ${x + ox},${y + oy},${usable},24`);
    y += 30;
    text(x, y, '2', `MANIP: ${labelDate(l.handledAt, tz)}`);
    y += 24;
    text(x, y, '3', `VAL: ${labelDate(l.expiresAt, tz, true)}`);
    y += 30;
    const resp = `RESP: ${plain(l.responsible)}`;
    const lot = `LOTE ${l.lot}`;
    const c2 = cols('2');
    const left = resp.slice(0, Math.max(0, c2 - lot.length - 1));
    text(x, y, '2', left + ' '.repeat(Math.max(1, c2 - left.length - lot.length)) + lot);
    y += 24;
    const extra = [l.quantityText, l.extra, l.notes].filter(Boolean).join(' - ');
    const foot = extra ? `${extra} - ${p.store.name}` : p.store.name;
    lines.push(`BAR ${x + ox},${y + oy},${usable},2`);
    text(x, y + 6, '1', foot);
  }
  lines.push(`PRINT 1,${clamp(Math.round(copies), 1, 50, 1)}`);
  return Buffer.from(lines.join('\r\n') + '\r\n', 'ascii');
}
