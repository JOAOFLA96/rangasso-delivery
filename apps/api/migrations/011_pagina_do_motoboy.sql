-- Página do motoboy: link pessoal (sem senha) para ver a rota e dar baixa pelo celular.
ALTER TABLE couriers ADD COLUMN access_token text UNIQUE;
-- "Estou chegando" enviado ao cliente e quem deu a baixa (motoboy pelo celular ou loja pelo painel).
ALTER TABLE delivery_run_stops ADD COLUMN arriving_at timestamptz;
ALTER TABLE delivery_run_stops ADD COLUMN outcome_by text CHECK (outcome_by IN ('courier', 'panel'));

-- Localização do motoboy durante a saída (só a última posição, sem histórico). O celular manda enquanto a saída está na rua.
ALTER TABLE couriers ADD COLUMN last_lat double precision;
ALTER TABLE couriers ADD COLUMN last_lng double precision;
ALTER TABLE couriers ADD COLUMN last_accuracy_m integer;
ALTER TABLE couriers ADD COLUMN last_location_at timestamptz;
ALTER TABLE couriers ADD COLUMN last_location_run_id uuid REFERENCES delivery_runs(id) ON DELETE SET NULL;
