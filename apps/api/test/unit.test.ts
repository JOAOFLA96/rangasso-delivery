import { describe, expect, it } from 'vitest';
import { computeOpenState } from '../src/services/storeHours.js';
import { effectivePrice, isPromoValid } from '../src/services/pricing.js';
import { normalizePhone, formatBRL } from '../src/lib/text.js';
import { canTransition } from '../src/services/orders.js';
import { backoffSeconds } from '../src/services/print.js';

const TZ = 'America/Sao_Paulo';
// 2026-10-21 é quarta-feira (weekday 3). 22:00 em SP = 01:00Z do dia 22.
const at = (iso: string) => new Date(iso);

describe('horário de funcionamento', () => {
  const shifts = [{ weekday: 3, opens_at: '18:00', closes_at: '23:00' }, { weekday: 5, opens_at: '18:00', closes_at: '02:00' }];
  it('aberto dentro do turno, no fuso da loja', () => {
    expect(computeOpenState(at('2026-10-22T01:00:00Z'), TZ, 'auto', shifts, new Set()).open).toBe(true);
  });
  it('fechado fora do turno e informa próxima abertura', () => {
    const s = computeOpenState(at('2026-10-21T15:00:00Z'), TZ, 'auto', shifts, new Set());
    expect(s.open).toBe(false);
    expect(s.nextOpening).toBe('hoje às 18:00');
  });
  it('turno que atravessa a meia-noite vale na madrugada seguinte', () => {
    // sexta 23/10 18:00 -> sábado 24/10 02:00. Sábado 01:30 SP = 04:30Z
    expect(computeOpenState(at('2026-10-24T04:30:00Z'), TZ, 'auto', shifts, new Set()).open).toBe(true);
    expect(computeOpenState(at('2026-10-24T05:30:00Z'), TZ, 'auto', shifts, new Set()).open).toBe(false);
  });
  it('exceção de data fecha a loja', () => {
    const s = computeOpenState(at('2026-10-22T01:00:00Z'), TZ, 'auto', shifts, new Set(['2026-10-21']));
    expect(s).toMatchObject({ open: false, reason: 'closure' });
  });
  it('modos forçados', () => {
    expect(computeOpenState(at('2026-10-21T15:00:00Z'), TZ, 'force_open', shifts, new Set()).open).toBe(true);
    expect(computeOpenState(at('2026-10-22T01:00:00Z'), TZ, 'force_closed', shifts, new Set()).open).toBe(false);
  });
});

describe('promoção', () => {
  const base = { price_cents: 4000, promo_price_cents: 3500, promo_active: true, promo_starts_at: null, promo_ends_at: null };
  it('vale sem período', () => expect(effectivePrice(base)).toBe(3500));
  it('expirada volta ao preço normal', () => {
    expect(isPromoValid({ ...base, promo_ends_at: '2020-01-01T00:00:00Z' })).toBe(false);
    expect(effectivePrice({ ...base, promo_ends_at: '2020-01-01T00:00:00Z' })).toBe(4000);
  });
  it('ainda não começou', () => expect(isPromoValid({ ...base, promo_starts_at: '2999-01-01T00:00:00Z' })).toBe(false));
  it('promo maior que o preço é ignorada', () => expect(effectivePrice({ ...base, promo_price_cents: 5000 })).toBe(4000));
  it('desativada', () => expect(effectivePrice({ ...base, promo_active: false })).toBe(4000));
});

describe('utilidades', () => {
  it('telefone', () => {
    expect(normalizePhone('(11) 98765-4321')).toBe('11987654321');
    expect(normalizePhone('+55 11 3333-4444')).toBe('1133334444');
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('11 88765-4321')).toBeNull();
  });
  it('moeda', () => {
    expect(formatBRL(123456)).toBe('R$ 1.234,56');
    expect(formatBRL(5)).toBe('R$ 0,05');
  });
  it('transições de status', () => {
    expect(canTransition('received', 'confirmed')).toBe(true);
    expect(canTransition('received', 'preparing')).toBe(true);
    expect(canTransition('preparing', 'confirmed')).toBe(false);
    expect(canTransition('completed', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'received')).toBe(false);
    expect(canTransition('out_for_delivery', 'cancelled')).toBe(true);
  });
  it('intervalo progressivo de retentativa', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(backoffSeconds)).toEqual([5, 15, 30, 60, 120, 300, 300]);
  });
});
