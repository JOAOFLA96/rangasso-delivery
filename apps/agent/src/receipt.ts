import { EscPos, leftRight, rule, wrap } from './escpos.js';

// Formata a comanda (dados congelados pelo servidor) em ESC/POS e também em texto puro,
// usado para pré-visualização, logs de diagnóstico e testes.

export interface ReceiptPayload {
  test?: boolean;
  store: { name: string; phone?: string; footer?: string; timezone?: string };
  columns: number;
  createdAt?: string;
  order?: {
    number: number;
    createdAt: string;
    customerName: string;
    customerPhone: string;
    address: { street: string; number: string; complement: string; reference: string; neighborhood: string; city: string; cep: string };
    notes: string;
    items: { quantity: number; name: string; unitPriceCents: number; lineTotalCents: number; notes: string; addons: { group: string; name: string; priceCents: number }[] }[];
    subtotalCents: number;
    deliveryFeeCents: number;
    deliveryFeePending?: boolean; // bairro novo, taxa ainda não definida pela loja
    deliveryDistanceKm?: number | null; // taxa por km: distância em linha reta da loja
    discountCents: number;
    totalCents: number;
    paymentMethod: 'cash' | 'pix' | 'card';
    changeForCents: number | null;
  };
}

export interface JobMeta { kind: 'original' | 'reprint' | 'test'; reprintNumber: number; copies: number }

const PAY: Record<string, string> = { cash: 'Dinheiro', pix: 'Pix', card: 'Cartão na entrega' };

export function brl(cents: number) {
  const neg = cents < 0;
  const a = Math.abs(cents);
  const reais = Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '-' : ''}R$ ${reais},${String(a % 100).padStart(2, '0')}`;
}

function fmtDate(iso: string, tz = 'America/Sao_Paulo') {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

type Op =
  | { t: 'line'; s: string; bold?: boolean; big?: 'wide' | 'tall'; align?: 'left' | 'center'; invert?: boolean }
  | { t: 'feed'; n: number };

// Descrição intermediária: gera ESC/POS e texto com o mesmo conteúdo.
export function receiptOps(p: ReceiptPayload, meta: JobMeta, copy: number, printedAt = new Date()): Op[] {
  const W = [32, 42, 48].includes(p.columns) ? p.columns : 48;
  const ops: Op[] = [];
  const L = (s: string, o: Partial<Extract<Op, { t: 'line' }>> = {}) => ops.push({ t: 'line', s, ...o });
  const tz = p.store.timezone;

  if (p.test || !p.order) {
    L(p.store.name.toUpperCase(), { align: 'center', bold: true, big: 'wide' });
    L('IMPRESSÃO DE TESTE', { align: 'center', bold: true });
    L(fmtDate(printedAt.toISOString(), tz), { align: 'center' });
    L(rule(W));
    L('Acentuação: ÁÉÍÓÚ áéíóú ÂÊÔ âêô ÃÕ ãõ Ç ç');
    L(`Largura: ${W} colunas`);
    L('0123456789'.repeat(Math.ceil(W / 10)).slice(0, W));
    for (const l of leftRight('Esquerda', 'Direita', W)) L(l);
    L(rule(W));
    L('Se este texto saiu completo e legível,', { align: 'center' });
    L('a impressora está pronta.', { align: 'center' });
    ops.push({ t: 'feed', n: 4 });
    return ops;
  }

  const o = p.order;
  L(`PEDIDO #${o.number}`, { align: 'center', bold: true, big: 'wide' });
  if (meta.kind === 'reprint') L(` REIMPRESSÃO Nº ${meta.reprintNumber} `, { align: 'center', bold: true, invert: true });
  L(p.store.name, { align: 'center' });
  L(fmtDate(o.createdAt, tz), { align: 'center' });
  if (meta.copies > 1) L(`Via ${copy}/${meta.copies}`, { align: 'center' });
  L(rule(W));
  for (const l of wrap(`CLIENTE: ${o.customerName}`, W)) L(l, { bold: true });
  L(`TEL: ${o.customerPhone}`);
  L('ENTREGA:', { bold: true });
  const a = o.address;
  for (const l of wrap(`${a.street}, ${a.number}${a.complement ? ` - ${a.complement}` : ''}`, W)) L(l, { bold: true });
  for (const l of wrap(`Bairro: ${a.neighborhood}${a.city ? ` - ${a.city}` : ''}`, W)) L(l, { bold: true });
  if (a.cep) L(`CEP: ${a.cep.slice(0, 5)}-${a.cep.slice(5)}`);
  if (a.reference) for (const l of wrap(`Ref.: ${a.reference}`, W)) L(l);
  L(rule(W, '='));

  for (const i of o.items) {
    for (const l of leftRight(`${i.quantity}x ${i.name}`, brl(i.lineTotalCents), W)) L(l, { bold: true });
    for (const ad of i.addons) for (const l of wrap(`+ ${ad.name}${ad.priceCents ? ` (${brl(ad.priceCents)})` : ''}`, W - 3).map((x) => `   ${x}`)) L(l);
    if (i.notes) for (const l of wrap(`OBS: ${i.notes}`, W - 3).map((x) => `   ${x}`)) L(l, { bold: true });
  }
  L(rule(W));
  for (const l of leftRight('Subtotal', brl(o.subtotalCents), W)) L(l);
  const feeLabel = o.deliveryDistanceKm != null ? `Taxa (${o.deliveryDistanceKm.toFixed(1).replace('.', ',')} km)` : 'Taxa de entrega';
  for (const l of leftRight(feeLabel, o.deliveryFeePending ? 'A COMBINAR' : brl(o.deliveryFeeCents), W)) L(l, { bold: !!o.deliveryFeePending });
  if (o.discountCents > 0) for (const l of leftRight('Desconto', `-${brl(o.discountCents)}`, W)) L(l);
  for (const l of leftRight(o.deliveryFeePending ? 'TOTAL + TAXA' : 'TOTAL', brl(o.totalCents), W)) L(l, { bold: true, big: 'tall' });
  L(rule(W));
  L(`PAGAMENTO: ${PAY[o.paymentMethod] ?? o.paymentMethod}`, { bold: true });
  if (o.paymentMethod === 'cash') {
    if (o.changeForCents) {
      L(`Troco para ${brl(o.changeForCents)}`);
      L(`LEVAR TROCO: ${brl(o.changeForCents - o.totalCents)}`, { bold: true });
    } else L('Sem troco');
  }
  if (o.notes) {
    L(rule(W));
    L('OBSERVAÇÕES DO PEDIDO:', { bold: true });
    for (const l of wrap(o.notes, W)) L(l, { bold: true });
  }
  L(rule(W));
  if (p.store.footer) for (const l of wrap(p.store.footer, W)) L(l, { align: 'center' });
  L(`Impresso em ${fmtDate(printedAt.toISOString(), tz)}`, { align: 'center' });
  ops.push({ t: 'feed', n: 4 });
  return ops;
}

export function renderEscPos(p: ReceiptPayload, meta: JobMeta, printedAt = new Date()): Buffer {
  const out = new EscPos();
  const copies = Math.max(1, Math.min(5, meta.copies || 1));
  for (let c = 1; c <= copies; c++) {
    for (const op of receiptOps(p, meta, c, printedAt)) {
      if (op.t === 'feed') {
        out.feed(op.n);
        continue;
      }
      out.align(op.align ?? 'left').bold(!!op.bold).invert(!!op.invert);
      out.size(op.big === 'wide' ? 2 : 1, op.big ? 2 : 1);
      out.line(op.s);
      out.size(1, 1).bold(false).invert(false);
    }
    out.align('left').cut();
  }
  return out.build();
}

// Pré-visualização em texto (como a comanda fica no papel, sem formatação).
export function renderText(p: ReceiptPayload, meta: JobMeta, printedAt = new Date()): string {
  const W = [32, 42, 48].includes(p.columns) ? p.columns : 48;
  const lines: string[] = [];
  const copies = Math.max(1, meta.copies || 1);
  for (let c = 1; c <= copies; c++) {
    for (const op of receiptOps(p, meta, c, printedAt)) {
      if (op.t === 'feed') continue;
      const width = op.big === 'wide' ? Math.floor(W / 2) : W;
      const s = op.align === 'center' ? op.s.padStart(Math.floor((width + op.s.length) / 2)) : op.s;
      lines.push(s);
    }
    lines.push('~'.repeat(W) + ' (corte)');
  }
  return lines.join('\n');
}
