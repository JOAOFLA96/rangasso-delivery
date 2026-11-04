-- Etiquetas de validade da cozinha (50x30 mm): cadastro de insumos/preparos com a validade de cada
-- forma de conservação, e o registro de cada etiqueta emitida (rastreabilidade, vencimentos e baixas).

CREATE TABLE label_products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  group_name      text NOT NULL DEFAULT '' CHECK (char_length(group_name) <= 40),
  -- Validade em horas para cada conservação. NULL = o produto não é guardado dessa forma.
  chilled_hours   integer CHECK (chilled_hours BETWEEN 1 AND 87600),
  frozen_hours    integer CHECK (frozen_hours BETWEEN 1 AND 87600),
  ambient_hours   integer CHECK (ambient_hours BETWEEN 1 AND 87600),
  default_storage text NOT NULL DEFAULT 'chilled' CHECK (default_storage IN ('chilled', 'frozen', 'ambient')),
  notes           text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 60),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (chilled_hours IS NOT NULL OR frozen_hours IS NOT NULL OR ambient_hours IS NOT NULL)
);
CREATE UNIQUE INDEX label_products_name_idx ON label_products(store_id, lower(name));

-- Uma linha por emissão (que pode ter várias cópias iguais). O nome do produto é copiado para o histórico
-- continuar correto mesmo se o cadastro mudar.
CREATE TABLE label_prints (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id      uuid REFERENCES label_products(id) ON DELETE SET NULL,
  product_name    text NOT NULL,
  label_type      text NOT NULL CHECK (label_type IN ('handled', 'opened', 'thawing', 'sample')),
  storage         text NOT NULL CHECK (storage IN ('chilled', 'frozen', 'ambient')),
  handled_at      timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL CHECK (expires_at > handled_at),
  responsible     text NOT NULL,
  lot             text NOT NULL,
  quantity_text   text NOT NULL DEFAULT '',
  extra           text NOT NULL DEFAULT '',
  copies          integer NOT NULL CHECK (copies BETWEEN 1 AND 50),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'discarded')),
  closed_at       timestamptz,
  closed_by       uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  close_reason    text NOT NULL DEFAULT '',
  printed_by      uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX label_prints_store_idx ON label_prints(store_id, created_at DESC);
CREATE INDEX label_prints_active_idx ON label_prints(store_id, expires_at) WHERE status = 'active';
CREATE UNIQUE INDEX label_prints_lot_idx ON label_prints(store_id, lot);
