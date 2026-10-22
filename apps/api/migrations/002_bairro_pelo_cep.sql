-- Bairro preenchido pelo CEP: pedidos de bairros ainda não cadastrados entram com "taxa a combinar"
-- e o bairro é cadastrado sozinho, aguardando a loja definir a taxa no painel.
ALTER TABLE store_settings ADD COLUMN accept_unlisted_neighborhoods boolean NOT NULL DEFAULT true;
ALTER TABLE neighborhoods ADD COLUMN fee_pending boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN delivery_fee_pending boolean NOT NULL DEFAULT false;
