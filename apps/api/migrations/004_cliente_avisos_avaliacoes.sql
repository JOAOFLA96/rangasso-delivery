-- Imagens guardadas no banco (hospedagens com disco temporário, como o Render grátis, apagam arquivos a cada reinício).
CREATE TABLE stored_images (
  path          text PRIMARY KEY,
  content       bytea NOT NULL,
  content_type  text NOT NULL DEFAULT 'image/webp',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Segredos gerados pelo próprio sistema (ex.: chaves VAPID das notificações push).
CREATE TABLE app_secrets (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Avisos no celular do cliente sobre um pedido (Web Push).
CREATE TABLE push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  endpoint    text NOT NULL,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, endpoint)
);

-- Avaliação do cliente após a entrega (uma por pedido).
CREATE TABLE order_reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_id    uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     text NOT NULL DEFAULT '',
  photo_path  text,
  hidden      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_reviews_store_created ON order_reviews (store_id, created_at DESC);
