-- Retirada na loja: o cliente busca o pedido, sem endereço e sem taxa de entrega.
ALTER TABLE store_settings ADD COLUMN accepts_pickup boolean NOT NULL DEFAULT true;

ALTER TABLE orders ADD COLUMN fulfillment text NOT NULL DEFAULT 'delivery' CHECK (fulfillment IN ('delivery', 'pickup'));
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_delivery_fee_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_delivery_fee_source_check CHECK (delivery_fee_source IN ('neighborhood', 'distance', 'pickup'));
