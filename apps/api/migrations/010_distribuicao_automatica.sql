-- Distribuição automática: pedido de entrega aceito entra sozinho numa saída aberta (até o limite) ou abre uma nova com um motoboy livre.
ALTER TABLE store_settings ADD COLUMN auto_dispatch boolean NOT NULL DEFAULT true;
ALTER TABLE store_settings ADD COLUMN auto_dispatch_max integer NOT NULL DEFAULT 5 CHECK (auto_dispatch_max BETWEEN 1 AND 10);
-- Saída aberta pelo sistema (e não pelo operador).
ALTER TABLE delivery_runs ADD COLUMN auto boolean NOT NULL DEFAULT false;
-- Pedido que o operador tirou de uma saída ou que voltou sem entregar: fica com o operador, a distribuição automática não mexe.
ALTER TABLE orders ADD COLUMN auto_dispatch_skip boolean NOT NULL DEFAULT false;
-- Mapa da tela de Entregas: traçado da rota (polyline do Google) e ponto de cada parada.
ALTER TABLE delivery_runs ADD COLUMN route_polyline text;
ALTER TABLE delivery_run_stops ADD COLUMN lat double precision, ADD COLUMN lng double precision;
