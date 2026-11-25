-- Pedidos do 99Food no mesmo painel e impressão.
-- channel: de onde veio o pedido. external_*: identificação no 99Food (order_id de 64 bits guardado como texto).
ALTER TABLE orders ADD COLUMN channel text NOT NULL DEFAULT 'site' CHECK (channel IN ('site', '99food'));
ALTER TABLE orders ADD COLUMN external_id text;
ALTER TABLE orders ADD COLUMN external_shop_id text;           -- app_shop_id da loja no 99Food
ALTER TABLE orders ADD COLUMN external_short_code text;        -- order_index: número curto do dia no 99Food
ALTER TABLE orders ADD COLUMN external_delivery text CHECK (external_delivery IN ('store', 'platform', 'pickup'));
ALTER TABLE orders ADD COLUMN external_info jsonb;             -- pagamento detalhado, códigos de entrega, telefone virtual
ALTER TABLE orders ADD COLUMN extra_fees_cents integer NOT NULL DEFAULT 0 CHECK (extra_fees_cents >= 0);
CREATE UNIQUE INDEX orders_channel_external_idx ON orders(store_id, channel, external_id) WHERE external_id IS NOT NULL;

-- "online": pago no app do 99Food (nada a receber na entrega).
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('cash', 'pix', 'card', 'online'));

-- Taxa de entrega definida pelo app (o 99Food calcula).
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_delivery_fee_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_delivery_fee_source_check CHECK (delivery_fee_source IN ('neighborhood', 'distance', 'pickup', 'app'));

-- Taxas extras do app (pedido mínimo, serviço, gorjeta) entram no total.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_check;
ALTER TABLE orders ADD CONSTRAINT orders_total_check CHECK (total_cents = subtotal_cents + delivery_fee_cents + extra_fees_cents - discount_cents);

-- Lojas do 99Food ligadas a este sistema e o token de acesso de cada uma (renovado sozinho).
CREATE TABLE food99_shops (
  app_shop_id      text PRIMARY KEY,
  store_id         uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  bound            boolean NOT NULL DEFAULT true,
  auth_token       text,
  token_expires_at timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Registro dos avisos recebidos do 99Food (sem dados do cliente), para conferência e suporte.
CREATE TABLE food99_events (
  id          bigserial PRIMARY KEY,
  store_id    uuid REFERENCES stores(id) ON DELETE CASCADE,
  type        text NOT NULL,
  app_shop_id text,
  order_id    text,
  result      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX food99_events_created_idx ON food99_events(created_at DESC);
