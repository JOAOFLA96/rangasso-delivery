import type { Db } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { formatBRL } from '../lib/text.js';

// Cupons de desconto. Toda regra é conferida aqui no servidor (o checkout só mostra o resultado).
// - percent: % sobre os itens (subtotal), com teto opcional em R$;
// - fixed: valor fixo sobre os itens (nunca passa do subtotal);
// - free_delivery: zera a taxa de entrega (não vale na retirada nem com taxa "a combinar").
// O pedido mínimo do cupom é conferido no subtotal dos itens (antes do desconto e sem a taxa).
// Pedido cancelado devolve o uso do cupom (os contadores ignoram cancelados).

export type CouponKind = 'percent' | 'fixed' | 'free_delivery';
export const COUPON_CODE_RE = /^[A-Z0-9_-]{3,20}$/;

export const normalizeCouponCode = (raw: string) => raw.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '').toUpperCase();

export interface CouponContext {
  subtotalCents: number;
  feeCents: number | null; // null = taxa ainda não calculada (endereço incompleto, só na prévia)
  feePending: boolean;
  pickup: boolean;
  phone: string | null; // só dígitos; sem telefone (prévia) as regras por cliente ficam para o envio
  now?: Date;
  lock?: boolean; // no envio do pedido: trava o cupom para contar os usos sem corrida
}

export interface AppliedCoupon { id: string; code: string; kind: CouponKind; description: string; discountCents: number; label: string }

const invalid = (message: string) => badRequest('coupon_invalid', message, { field: 'couponCode' });

export function couponLabel(c: { kind: string; percent: number | null; amount_cents: number | null; max_discount_cents: number | null }) {
  if (c.kind === 'percent') return `${c.percent}% de desconto${c.max_discount_cents ? ` (até ${formatBRL(c.max_discount_cents)})` : ''}`;
  if (c.kind === 'fixed') return `${formatBRL(c.amount_cents ?? 0)} de desconto`;
  return 'Entrega grátis';
}

export function discountFor(c: { kind: string; percent: number | null; amount_cents: number | null; max_discount_cents: number | null }, subtotal: number, fee: number) {
  if (c.kind === 'percent') {
    const d = Math.round((subtotal * (c.percent ?? 0)) / 100);
    return Math.min(subtotal, c.max_discount_cents ? Math.min(d, c.max_discount_cents) : d);
  }
  if (c.kind === 'fixed') return Math.min(subtotal, c.amount_cents ?? 0);
  return Math.max(0, fee);
}

export async function applyCoupon(db: Db, storeId: string, rawCode: string, ctx: CouponContext): Promise<AppliedCoupon> {
  const code = normalizeCouponCode(rawCode);
  if (!COUPON_CODE_RE.test(code)) throw invalid('Cupom inválido. Confira o código.');
  const r = await db.query(
    `SELECT * FROM coupons WHERE store_id = $1 AND code = $2 AND archived_at IS NULL${ctx.lock ? ' FOR UPDATE' : ''}`,
    [storeId, code],
  );
  const c = r.rows[0];
  if (!c || !c.active) throw invalid('Cupom inválido ou desativado. Confira o código.');
  const now = ctx.now ?? new Date();
  if (c.starts_at && new Date(c.starts_at) > now) throw invalid('Este cupom ainda não está valendo.');
  if (c.ends_at && new Date(c.ends_at) <= now) throw invalid('Este cupom expirou.');
  if (ctx.subtotalCents < c.min_order_cents) {
    throw invalid(`Este cupom vale para pedidos a partir de ${formatBRL(c.min_order_cents)} (sem a taxa de entrega).`);
  }
  if (c.kind === 'free_delivery') {
    if (ctx.pickup) throw invalid('Este cupom é de entrega grátis: não vale para retirada na loja.');
    if (ctx.feePending) throw invalid('Este cupom é de entrega grátis, mas a taxa do seu bairro ainda vai ser combinada com a loja.');
    if (ctx.feeCents === 0) throw invalid('Sua entrega já está sem taxa.');
  }

  if (c.max_uses != null) {
    const u = await db.query(`SELECT count(*)::int AS n FROM orders WHERE coupon_id = $1 AND status <> 'cancelled'`, [c.id]);
    if (u.rows[0].n >= c.max_uses) throw invalid('Este cupom já atingiu o limite de usos.');
  }
  if (ctx.phone) {
    if (c.max_uses_per_phone != null) {
      const u = await db.query(`SELECT count(*)::int AS n FROM orders WHERE coupon_id = $1 AND customer_phone = $2 AND status <> 'cancelled'`, [c.id, ctx.phone]);
      if (u.rows[0].n >= c.max_uses_per_phone) {
        throw invalid(c.max_uses_per_phone === 1 ? 'Você já usou este cupom.' : `Você já usou este cupom ${c.max_uses_per_phone} vezes (limite por cliente).`);
      }
    }
    if (c.first_order_only) {
      const u = await db.query(`SELECT 1 FROM orders WHERE store_id = $1 AND customer_phone = $2 AND status <> 'cancelled' LIMIT 1`, [storeId, ctx.phone]);
      if (u.rowCount) throw invalid('Este cupom é só para o primeiro pedido.');
    }
  }

  const discount = discountFor(c, ctx.subtotalCents, ctx.feeCents ?? 0);
  return { id: c.id, code: c.code, kind: c.kind, description: c.description, discountCents: discount, label: couponLabel(c) };
}
