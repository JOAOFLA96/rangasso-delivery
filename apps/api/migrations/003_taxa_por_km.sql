-- Taxa de entrega por distância (linha reta) a partir da localização da loja.
ALTER TABLE store_settings
  ADD COLUMN delivery_fee_mode text NOT NULL DEFAULT 'neighborhood' CHECK (delivery_fee_mode IN ('neighborhood', 'distance')),
  ADD COLUMN store_lat double precision CHECK (store_lat BETWEEN -90 AND 90),
  ADD COLUMN store_lng double precision CHECK (store_lng BETWEEN -180 AND 180);

-- Faixas: até max_km cobra fee_cents. Acima da maior faixa, não entrega.
CREATE TABLE delivery_distance_tiers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id   uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  max_km     numeric(6,2) NOT NULL CHECK (max_km > 0 AND max_km <= 200),
  fee_cents  integer NOT NULL CHECK (fee_cents >= 0 AND fee_cents <= 100000),
  UNIQUE (store_id, max_km)
);

-- Endereços já localizados (evita repetir consultas ao serviço de mapas). lat nulo = não encontrado.
CREATE TABLE geocode_cache (
  query_key    text PRIMARY KEY,
  lat          double precision,
  lng          double precision,
  precision    text,
  label        text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orders
  ADD COLUMN delivery_distance_km numeric(6,2),
  ADD COLUMN delivery_fee_source text NOT NULL DEFAULT 'neighborhood' CHECK (delivery_fee_source IN ('neighborhood', 'distance'));
