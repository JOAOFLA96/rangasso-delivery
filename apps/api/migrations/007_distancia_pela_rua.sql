-- Taxa por km pela rota de carro (OpenRouteService), com a linha reta como reserva.
CREATE TABLE IF NOT EXISTS route_cache (
  route_key text PRIMARY KEY,
  distance_m integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Como a distância do pedido foi medida: 'route' (pelas ruas) ou 'straight' (linha reta).
ALTER TABLE orders ADD COLUMN delivery_distance_by text CHECK (delivery_distance_by IN ('route', 'straight'));
UPDATE orders SET delivery_distance_by = 'straight' WHERE delivery_distance_km IS NOT NULL;
