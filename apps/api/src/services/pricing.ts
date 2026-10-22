// Regras de preço. Toda a conta do pedido é refeita aqui no servidor; o navegador só exibe.

export interface PromoFields {
  price_cents: number;
  promo_price_cents: number | null;
  promo_active: boolean;
  promo_starts_at: Date | string | null;
  promo_ends_at: Date | string | null;
}

export function isPromoValid(p: PromoFields, now = new Date()) {
  if (!p.promo_active || p.promo_price_cents == null) return false;
  if (p.promo_price_cents >= p.price_cents) return false;
  if (p.promo_starts_at && new Date(p.promo_starts_at) > now) return false;
  if (p.promo_ends_at && new Date(p.promo_ends_at) <= now) return false;
  return true;
}

export const effectivePrice = (p: PromoFields, now = new Date()) => (isPromoValid(p, now) ? p.promo_price_cents! : p.price_cents);
