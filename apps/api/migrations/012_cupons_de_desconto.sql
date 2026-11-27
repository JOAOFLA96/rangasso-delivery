-- Cupons de desconto: o cliente digita o código no checkout e o servidor confere todas as regras.
-- Tipos: porcentagem sobre os itens (com teto opcional), valor fixo sobre os itens, ou entrega grátis (zera a taxa).
CREATE TABLE IF NOT EXISTS coupons (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id           uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  code               text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{3,20}$'),
  description        text NOT NULL DEFAULT '',
  kind               text NOT NULL CHECK (kind IN ('percent','fixed','free_delivery')),
  percent            integer CHECK (percent IS NULL OR (percent BETWEEN 1 AND 100)),
  amount_cents       integer CHECK (amount_cents IS NULL OR amount_cents > 0),
  max_discount_cents integer CHECK (max_discount_cents IS NULL OR max_discount_cents > 0),
  min_order_cents    integer NOT NULL DEFAULT 0 CHECK (min_order_cents >= 0),
  starts_at          timestamptz,
  ends_at            timestamptz,
  max_uses           integer CHECK (max_uses IS NULL OR max_uses > 0),
  max_uses_per_phone integer CHECK (max_uses_per_phone IS NULL OR max_uses_per_phone > 0),
  first_order_only   boolean NOT NULL DEFAULT false,
  active             boolean NOT NULL DEFAULT true,
  archived_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'percent' OR percent IS NOT NULL),
  CHECK (kind <> 'fixed' OR amount_cents IS NOT NULL),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
-- Código único entre os cupons não apagados (um código apagado pode ser reaproveitado).
CREATE UNIQUE INDEX IF NOT EXISTS coupons_store_code_uq ON coupons (store_id, code) WHERE archived_at IS NULL;

-- O pedido guarda o cupom usado e o código (congelado, mesmo se o cupom mudar depois).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_id uuid REFERENCES coupons(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code text;
CREATE INDEX IF NOT EXISTS orders_coupon_idx ON orders (coupon_id) WHERE coupon_id IS NOT NULL;
