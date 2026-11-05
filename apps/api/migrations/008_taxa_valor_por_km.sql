-- Taxa por km: por faixas (como antes) ou por valor do km (km pelas ruas × valor), com taxa mínima e raio máximo.
ALTER TABLE store_settings ADD COLUMN distance_pricing text NOT NULL DEFAULT 'tiers' CHECK (distance_pricing IN ('tiers', 'per_km'));
ALTER TABLE store_settings ADD COLUMN price_per_km_cents integer NOT NULL DEFAULT 0 CHECK (price_per_km_cents >= 0);
ALTER TABLE store_settings ADD COLUMN distance_min_fee_cents integer NOT NULL DEFAULT 0 CHECK (distance_min_fee_cents >= 0);
ALTER TABLE store_settings ADD COLUMN distance_max_km numeric(6,2) CHECK (distance_max_km IS NULL OR distance_max_km > 0);
