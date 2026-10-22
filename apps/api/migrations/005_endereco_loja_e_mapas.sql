-- Endereço da loja: preenche com o informado pelo dono quando ainda estiver vazio.
UPDATE store_settings SET address = 'Av. Itororó, 681 - Cidade Nova I, Indaiatuba - SP, 13334-050' WHERE address = '';

-- A busca de endereços ganhou outros serviços de mapas: apaga os "não achei" guardados para que sejam tentados de novo.
DELETE FROM geocode_cache WHERE lat IS NULL;
