-- Plano B da taxa por km: cada endereço que o Google mediu fica guardado (CEP + número, rua, bairro, distância e taxa).
-- Se o Google ficar fora do ar ou a chave falhar, o pedido usa a distância guardada do mesmo endereço ou do mesmo CEP.
CREATE TABLE IF NOT EXISTS delivery_addresses (
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  cep text NOT NULL,
  number text NOT NULL DEFAULT '',
  street text NOT NULL DEFAULT '',
  neighborhood text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  distance_km numeric(6,2) NOT NULL CHECK (distance_km >= 0),
  fee_cents integer CHECK (fee_cents IS NULL OR fee_cents >= 0),
  uses integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, cep, number)
);
CREATE INDEX IF NOT EXISTS delivery_addresses_cep_idx ON delivery_addresses (store_id, cep);
