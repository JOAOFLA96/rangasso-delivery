import { describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { leftRight, sanitize, wrap } from '../src/escpos.js';
import { brl, renderEscPos, renderText, type ReceiptPayload } from '../src/receipt.js';

export const orderPayload = (columns = 48): ReceiptPayload => ({
  store: { name: 'Rangasso', footer: 'Obrigado pela preferência!', timezone: 'America/Sao_Paulo' },
  columns,
  order: {
    number: 1042,
    createdAt: '2026-10-21T23:15:00.000Z',
    customerName: 'José Antônio da Conceição',
    customerPhone: '(11) 98888-7777',
    address: { street: 'Rua São João', number: '123', complement: 'Apto 4', reference: 'Próximo à praça', neighborhood: 'Centro', city: 'São Paulo', cep: '01010-000' },
    notes: 'Tocar a campainha',
    items: [
      { quantity: 2, name: 'X-Bacon Artesanal com Cebola Caramelizada e Molho Especial', unitPriceCents: 3290, lineTotalCents: 7580, notes: 'Sem tomate', addons: [{ group: 'Adicionais', name: 'Queijo extra', priceCents: 500 }] },
      { quantity: 1, name: 'Guaraná 2L', unitPriceCents: 1200, lineTotalCents: 1200, notes: '', addons: [] },
    ],
    subtotalCents: 8780,
    deliveryFeeCents: 700,
    discountCents: 0,
    totalCents: 9480,
    paymentMethod: 'cash',
    changeForCents: 10000,
  },
});

describe('texto da comanda', () => {
  it('formata dinheiro em reais', () => {
    expect(brl(0)).toBe('R$ 0,00');
    expect(brl(9480)).toBe('R$ 94,80');
    expect(brl(123456789)).toBe('R$ 1.234.567,89');
    expect(brl(-500)).toBe('-R$ 5,00');
  });

  it('quebra linhas sem passar da largura', () => {
    for (const w of [32, 42, 48]) {
      for (const l of wrap('X-Bacon Artesanal com Cebola Caramelizada e Molho Especial e mais um pouco', w, '  ')) expect(l.length).toBeLessThanOrEqual(w);
      for (const l of leftRight('2x X-Bacon Artesanal com Cebola Caramelizada', 'R$ 75,80', w)) expect(l.length).toBeLessThanOrEqual(w);
    }
  });

  it('remove emojis e troca aspas tipográficas', () => {
    expect(sanitize('Sem “cebola” 🍔 – ok…')).toBe('Sem "cebola"  - ok...');
  });

  it('nenhuma linha passa da largura do papel (32/42/48)', () => {
    for (const w of [32, 42, 48]) {
      const txt = renderText(orderPayload(w), { kind: 'original', reprintNumber: 0, copies: 1 });
      for (const l of txt.split('\n')) if (!l.includes('(corte)')) expect(l.length, l).toBeLessThanOrEqual(w);
    }
  });

  it('mostra dados essenciais, troco e reimpressão', () => {
    const txt = renderText(orderPayload(), { kind: 'reprint', reprintNumber: 2, copies: 1 });
    expect(txt).toContain('PEDIDO #1042');
    expect(txt).toContain('REIMPRESSÃO Nº 2');
    expect(txt).toContain('José Antônio da Conceição');
    expect(txt).toContain('Rua São João');
    expect(txt).toContain('Sem tomate');
    expect(txt).toContain('Queijo extra');
    expect(txt).toContain('R$ 94,80');
    expect(txt).toMatch(/TROCO/);
    expect(txt).toContain('R$ 5,20'); // 100,00 - 94,80
  });
});

describe('ESC/POS', () => {
  it('bairro novo sem taxa definida sai como "a combinar"', () => {
    const p = orderPayload();
    p.order!.deliveryFeePending = true;
    p.order!.deliveryFeeCents = 0;
    const txt = renderText(p, { kind: 'original', reprintNumber: 0, copies: 1 });
    expect(txt).toMatch(/Taxa de entrega\s+A COMBINAR/);
    expect(txt).toContain('TOTAL + TAXA');
  });

  it('taxa por km mostra a distância', () => {
    const p = orderPayload();
    p.order!.deliveryDistanceKm = 3.04;
    expect(renderText(p, { kind: 'original', reprintNumber: 0, copies: 1 })).toMatch(/Taxa \(3,0 km\)\s+R\$/);
  });

  it('retirada na loja: sem endereço e sem taxa', () => {
    const p = orderPayload();
    p.order!.fulfillment = 'pickup';
    p.order!.deliveryFeeCents = 0;
    p.order!.paymentMethod = 'card';
    const txt = renderText(p, { kind: 'original', reprintNumber: 0, copies: 1 });
    expect(txt).toContain('RETIRADA NA LOJA');
    expect(txt).not.toContain('Rua São João');
    expect(txt).not.toContain('Taxa de entrega');
    expect(txt).toContain('Cartão na retirada');
  });

  it('inicializa, seleciona PC860 e corta uma vez por via', () => {
    const buf = renderEscPos(orderPayload(), { kind: 'original', reprintNumber: 0, copies: 2 });
    expect([...buf.subarray(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x74, 3]);
    let cuts = 0;
    for (let i = 0; i < buf.length - 3; i++) if (buf[i] === 0x1d && buf[i + 1] === 0x56 && buf[i + 2] === 66) cuts++;
    expect(cuts).toBe(2);
  });

  it('acentos codificados em CP860 (sem "?")', () => {
    const buf = renderEscPos(orderPayload(), { kind: 'original', reprintNumber: 0, copies: 1 });
    const text = iconv.decode(buf, 'cp860');
    expect(text).toContain('José Antônio da Conceição');
    expect(text).toContain('Próximo à praça');
    expect(buf.includes(Buffer.from('Jos?'))).toBe(false);
    expect(buf.includes(iconv.encode('ç', 'cp860'))).toBe(true);
  });

  it('comanda de teste mostra a régua na largura certa', () => {
    const txt = renderText({ test: true, store: { name: 'Rangasso' }, columns: 42 }, { kind: 'test', reprintNumber: 0, copies: 1 });
    expect(txt).toContain('IMPRESSÃO DE TESTE');
    expect(txt).toContain('0123456789'.repeat(5).slice(0, 42));
  });
});

describe('etiqueta de validade na bobina', () => {
  const labelPayload = (columns = 48): ReceiptPayload => ({
    store: { name: 'Rangasso', timezone: 'America/Sao_Paulo' },
    columns,
    label: {
      productName: 'Frango desfiado', labelType: 'handled', storage: 'chilled',
      handledAt: '2026-11-04T13:30:00.000Z', expiresAt: '2026-11-07T13:30:00.000Z',
      responsible: 'Carlos', lot: '261104-003', quantityText: '2 kg', extra: '', notes: 'Manter até 4 °C',
    },
  });

  it('mostra produto, manipulação, validade com dia da semana no fuso da loja, responsável e lote', () => {
    const txt = renderText(labelPayload(), { kind: 'label', reprintNumber: 0, copies: 1 });
    expect(txt).toContain('FRANGO DESFIADO');
    expect(txt).toContain('MANIPULADO - RESFRIADO (ATÉ 5°C)');
    expect(txt).toContain('MANIPULAÇÃO: 04/11/26 10:30');
    expect(txt).toContain('VAL: SÁB 07/11/26 10:30');
    expect(txt).toMatch(/RESP\.: Carlos\s+LOTE: 261104-003/);
    expect(txt).toContain('2 kg - Manter até 4 °C');
    for (const w of [32, 42, 48]) {
      for (const l of renderText(labelPayload(w), { kind: 'label', reprintNumber: 0, copies: 1 }).split('\n')) {
        if (!l.includes('(corte)')) expect(l.length, l).toBeLessThanOrEqual(w);
      }
    }
  });

  it('corta cada cópia (até 50) e codifica acentos e grau na CP860', () => {
    const bytes = renderEscPos(labelPayload(), { kind: 'label', reprintNumber: 0, copies: 12 });
    const cuts = bytes.toString('latin1').split('\x1dVB').length - 1;
    expect(cuts).toBe(12);
    expect(bytes.includes(iconv.encode('ATÉ 5°C', 'cp860'))).toBe(true);
    const many = renderEscPos(labelPayload(), { kind: 'label', reprintNumber: 0, copies: 80 });
    expect(many.toString('latin1').split('\x1dVB').length - 1).toBe(50);
  });
});
