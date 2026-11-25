-- Motoboys e rotas de entrega: o painel junta pedidos numa saída, o Google ordena as paradas e o motoboy recebe o link do mapa.
CREATE TABLE couriers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  phone       text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX couriers_store_name_idx ON couriers(store_id, lower(name));

-- Uma saída do motoboy: planned (montando) → out (saiu) → done (voltou). cancelled = desfeita antes de sair.
CREATE TABLE delivery_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  number            integer NOT NULL,
  courier_id        uuid REFERENCES couriers(id),
  status            text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'out', 'done', 'cancelled')),
  -- route_by: google = ordem otimizada pelo Google; google_manual = ordem escolhida no painel, medida pelo Google;
  -- distance = sem Google, ordem pela distância de cada pedido até a loja (aproximada).
  route_by          text NOT NULL DEFAULT 'distance' CHECK (route_by IN ('google', 'google_manual', 'distance')),
  route_error       text,
  total_distance_m  integer,          -- ida e volta à loja
  total_duration_s  integer,          -- tempo de direção previsto, sem contar o tempo parado em cada entrega
  created_by        uuid REFERENCES admin_users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  departed_at       timestamptz,
  finished_at       timestamptz,
  UNIQUE (store_id, number)
);
CREATE INDEX delivery_runs_store_status_idx ON delivery_runs(store_id, status, created_at DESC);

-- Paradas: histórico fica guardado mesmo depois que a saída termina.
CREATE TABLE delivery_run_stops (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES delivery_runs(id) ON DELETE CASCADE,
  order_id         uuid NOT NULL REFERENCES orders(id),
  position         integer NOT NULL,
  leg_distance_m   integer,           -- da parada anterior (ou da loja) até esta
  leg_duration_s   integer,
  outcome          text CHECK (outcome IN ('delivered', 'not_delivered')),
  outcome_note     text NOT NULL DEFAULT '',
  outcome_at       timestamptz,
  UNIQUE (run_id, order_id)
);
CREATE INDEX delivery_run_stops_order_idx ON delivery_run_stops(order_id);

-- Saída em que o pedido está agora (vazio = disponível para montar rota). Impede o mesmo pedido em duas saídas.
ALTER TABLE orders ADD COLUMN delivery_run_id uuid REFERENCES delivery_runs(id);
CREATE INDEX orders_delivery_run_idx ON orders(delivery_run_id);
