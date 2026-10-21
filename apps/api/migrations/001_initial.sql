-- 001_initial: estrutura base do delivery Rangasso.
-- Valores monetários sempre em centavos inteiros (integer). Nunca usar float para dinheiro.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Lojas ---------------------------------------------------------------------
CREATE TABLE stores (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE store_settings (
  store_id                uuid PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  display_name            text NOT NULL,
  tagline                 text NOT NULL DEFAULT '',
  logo_path               text,
  phone                   text NOT NULL DEFAULT '',
  whatsapp                text NOT NULL DEFAULT '',
  address                 text NOT NULL DEFAULT '',
  menu_message            text NOT NULL DEFAULT '',
  closed_message          text NOT NULL DEFAULT 'Estamos fechados no momento. Confira nosso horário de funcionamento.',
  delivery_instructions   text NOT NULL DEFAULT '',
  privacy_contact         text NOT NULL DEFAULT '',
  timezone                text NOT NULL DEFAULT 'America/Sao_Paulo',
  min_order_cents         integer NOT NULL DEFAULT 0 CHECK (min_order_cents >= 0),
  eta_min_minutes         integer NOT NULL DEFAULT 40 CHECK (eta_min_minutes >= 0),
  eta_max_minutes         integer NOT NULL DEFAULT 60 CHECK (eta_max_minutes >= eta_min_minutes),
  accepts_cash            boolean NOT NULL DEFAULT true,
  accepts_pix             boolean NOT NULL DEFAULT true,
  accepts_card            boolean NOT NULL DEFAULT true,
  pix_key                 text NOT NULL DEFAULT '',
  pix_instructions        text NOT NULL DEFAULT '',
  open_mode               text NOT NULL DEFAULT 'auto' CHECK (open_mode IN ('auto','force_open','force_closed')),
  -- impressora (configuração lógica; detalhes físicos ficam também no config do agente)
  printer_model           text NOT NULL DEFAULT 'Epson TM-T20 (variante a confirmar)',
  printer_connection      text NOT NULL DEFAULT 'usb' CHECK (printer_connection IN ('usb','network','serial')),
  printer_host            text NOT NULL DEFAULT '',
  printer_port            integer NOT NULL DEFAULT 9100 CHECK (printer_port BETWEEN 1 AND 65535),
  printer_windows_name    text NOT NULL DEFAULT '',
  auto_print              boolean NOT NULL DEFAULT true,
  print_copies            integer NOT NULL DEFAULT 1 CHECK (print_copies BETWEEN 1 AND 5),
  paper_columns           integer NOT NULL DEFAULT 48 CHECK (paper_columns IN (32, 42, 48)),
  receipt_footer          text NOT NULL DEFAULT 'Obrigado pela preferência!',
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Horário de funcionamento. weekday: 0=domingo ... 6=sábado (horário local da loja).
-- Se closes_at <= opens_at, o turno atravessa a meia-noite.
CREATE TABLE opening_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens_at    time NOT NULL,
  closes_at   time NOT NULL
);
CREATE INDEX opening_hours_store_idx ON opening_hours(store_id, weekday);

-- Exceções: dia fechado (ou horário especial) numa data específica.
CREATE TABLE store_closures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  date        date NOT NULL,
  reason      text NOT NULL DEFAULT '',
  UNIQUE (store_id, date)
);

-- Usuários e sessões ---------------------------------------------------------
CREATE TABLE admin_users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  email           text NOT NULL CHECK (email = lower(email)),
  name            text NOT NULL,
  password_hash   text NOT NULL,
  role            text NOT NULL CHECK (role IN ('owner','manager','staff')),
  active          boolean NOT NULL DEFAULT true,
  failed_logins   integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email)
);

CREATE TABLE admin_sessions (
  id_hash       text PRIMARY KEY,               -- sha256 do token; o token em si só existe no cookie
  user_id       uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  store_id      uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  ip            text,
  user_agent    text
);
CREATE INDEX admin_sessions_user_idx ON admin_sessions(user_id);

-- Cardápio -------------------------------------------------------------------
CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX categories_store_idx ON categories(store_id, sort_order);

CREATE TABLE products (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  category_id       uuid NOT NULL REFERENCES categories(id),
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  image_path        text,
  price_cents       integer NOT NULL CHECK (price_cents >= 0),
  promo_price_cents integer CHECK (promo_price_cents IS NULL OR promo_price_cents >= 0),
  promo_active      boolean NOT NULL DEFAULT false,
  promo_starts_at   timestamptz,
  promo_ends_at     timestamptz,
  available         boolean NOT NULL DEFAULT true,   -- disponibilidade do dia (ex.: acabou)
  active            boolean NOT NULL DEFAULT true,   -- aparece no cardápio
  archived_at       timestamptz,                     -- "excluído" sem quebrar pedidos antigos
  track_stock       boolean NOT NULL DEFAULT false,
  stock_qty         integer CHECK (stock_qty IS NULL OR stock_qty >= 0),
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (promo_ends_at IS NULL OR promo_starts_at IS NULL OR promo_ends_at > promo_starts_at)
);
CREATE INDEX products_store_cat_idx ON products(store_id, category_id, sort_order);

CREATE TABLE addon_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name        text NOT NULL,
  min_select  integer NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select  integer NOT NULL DEFAULT 1 CHECK (max_select >= 1),
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  CHECK (max_select >= min_select)
);
CREATE INDEX addon_groups_product_idx ON addon_groups(product_id);

CREATE TABLE addons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  group_id    uuid NOT NULL REFERENCES addon_groups(id) ON DELETE CASCADE,
  name        text NOT NULL,
  price_cents integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  available   boolean NOT NULL DEFAULT true,
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0
);
CREATE INDEX addons_group_idx ON addons(group_id);

-- Entrega ----------------------------------------------------------------------
CREATE TABLE neighborhoods (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name        text NOT NULL,
  city        text NOT NULL DEFAULT '',
  fee_cents   integer NOT NULL CHECK (fee_cents >= 0),
  min_order_cents integer CHECK (min_order_cents IS NULL OR min_order_cents >= 0), -- regra adicional opcional por bairro
  active      boolean NOT NULL DEFAULT true,          -- false = região não atendida
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX neighborhoods_unique_name ON neighborhoods(store_id, lower(name), lower(city));

-- Pedidos ----------------------------------------------------------------------
CREATE TABLE store_counters (
  store_id          uuid PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  last_order_number integer NOT NULL DEFAULT 0
);

CREATE TABLE orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id            uuid NOT NULL REFERENCES stores(id),
  number              integer NOT NULL,
  public_token        text NOT NULL UNIQUE,              -- link de acompanhamento do cliente (não adivinhável)
  idempotency_key     text NOT NULL,
  request_hash        text NOT NULL,
  status              text NOT NULL DEFAULT 'received'
                      CHECK (status IN ('received','confirmed','preparing','out_for_delivery','completed','cancelled')),
  customer_name       text NOT NULL,
  customer_phone      text NOT NULL,
  cep                 text NOT NULL DEFAULT '',
  street              text NOT NULL,
  street_number       text NOT NULL,
  complement          text NOT NULL DEFAULT '',
  reference           text NOT NULL DEFAULT '',
  neighborhood_id     uuid REFERENCES neighborhoods(id),
  neighborhood_name   text NOT NULL,
  city                text NOT NULL DEFAULT '',
  notes               text NOT NULL DEFAULT '',
  payment_method      text NOT NULL CHECK (payment_method IN ('cash','pix','card')),
  change_for_cents    integer CHECK (change_for_cents IS NULL OR change_for_cents >= 0),
  subtotal_cents      integer NOT NULL CHECK (subtotal_cents >= 0),
  delivery_fee_cents  integer NOT NULL CHECK (delivery_fee_cents >= 0),
  discount_cents      integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  total_cents         integer NOT NULL CHECK (total_cents >= 0),
  print_status        text NOT NULL DEFAULT 'not_queued'
                      CHECK (print_status IN ('not_queued','pending','claimed','sending','sent','printed','failed','uncertain')),
  cancel_reason       text,
  customer_ip_hash    text,
  anonymized_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, number),
  UNIQUE (store_id, idempotency_key),
  CHECK (total_cents = subtotal_cents + delivery_fee_cents - discount_cents)
);
CREATE INDEX orders_store_created_idx ON orders(store_id, created_at DESC);
CREATE INDEX orders_store_status_idx ON orders(store_id, status);
CREATE INDEX orders_store_phone_idx ON orders(store_id, customer_phone);

CREATE TABLE order_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  store_id            uuid NOT NULL REFERENCES stores(id),
  product_id          uuid REFERENCES products(id),
  -- cópia dos dados no momento da venda
  product_name        text NOT NULL,
  category_name       text NOT NULL DEFAULT '',
  regular_price_cents integer NOT NULL,
  unit_price_cents    integer NOT NULL,        -- preço cobrado (promocional, se válido)
  addons_unit_cents   integer NOT NULL DEFAULT 0,
  quantity            integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  line_total_cents    integer NOT NULL,
  notes               text NOT NULL DEFAULT '',
  position            integer NOT NULL DEFAULT 0,
  CHECK (line_total_cents = (unit_price_cents + addons_unit_cents) * quantity)
);
CREATE INDEX order_items_order_idx ON order_items(order_id);

CREATE TABLE order_item_addons (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id   uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  addon_id        uuid REFERENCES addons(id),
  group_name      text NOT NULL,
  addon_name      text NOT NULL,
  price_cents     integer NOT NULL
);
CREATE INDEX order_item_addons_item_idx ON order_item_addons(order_item_id);

CREATE TABLE order_status_history (
  id            bigserial PRIMARY KEY,
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  store_id      uuid NOT NULL REFERENCES stores(id),
  from_status   text,
  to_status     text NOT NULL,
  changed_by    uuid REFERENCES admin_users(id),
  note          text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_status_history_order_idx ON order_status_history(order_id, created_at);

-- Impressão --------------------------------------------------------------------
CREATE TABLE print_devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name            text NOT NULL,
  token_hash      text NOT NULL UNIQUE,   -- sha256 do token; o token só é mostrado uma vez
  token_prefix    text NOT NULL,          -- primeiros caracteres, para identificar na tela
  created_by      uuid REFERENCES admin_users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  last_seen_at    timestamptz,
  last_ip         text,
  agent_version   text,
  printer_state   jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error      text,
  last_error_at   timestamptz
);

CREATE TABLE print_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          uuid NOT NULL REFERENCES stores(id),
  order_id          uuid REFERENCES orders(id),
  kind              text NOT NULL CHECK (kind IN ('original','reprint','test')),
  reprint_number    integer NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','claimed','sending','sent','printed','failed','uncertain','cancelled')),
  copies            integer NOT NULL DEFAULT 1,
  payload           jsonb NOT NULL,         -- dados da comanda congelados na criação
  device_id         uuid REFERENCES print_devices(id),
  attempts          integer NOT NULL DEFAULT 0,
  max_attempts      integer NOT NULL DEFAULT 8,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  lease_expires_at  timestamptz,
  claimed_at        timestamptz,
  sent_at           timestamptz,
  printed_at        timestamptz,
  last_error        text,
  requested_by      uuid REFERENCES admin_users(id),
  reason            text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX print_jobs_one_original ON print_jobs(order_id) WHERE kind = 'original';
CREATE INDEX print_jobs_queue_idx ON print_jobs(store_id, status, next_attempt_at);
CREATE INDEX print_jobs_order_idx ON print_jobs(order_id);

CREATE TABLE print_job_events (
  id          bigserial PRIMARY KEY,
  job_id      uuid NOT NULL REFERENCES print_jobs(id) ON DELETE CASCADE,
  store_id    uuid NOT NULL REFERENCES stores(id),
  device_id   uuid REFERENCES print_devices(id),
  event       text NOT NULL,
  detail      text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX print_job_events_job_idx ON print_job_events(job_id, created_at);

-- Auditoria --------------------------------------------------------------------
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  store_id    uuid REFERENCES stores(id),
  user_id     uuid REFERENCES admin_users(id),
  device_id   uuid REFERENCES print_devices(id),
  action      text NOT NULL,
  entity      text NOT NULL DEFAULT '',
  entity_id   text NOT NULL DEFAULT '',
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_store_created_idx ON audit_log(store_id, created_at DESC);
