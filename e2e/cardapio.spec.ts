import { expect, test, type Page } from '@playwright/test';
import { db, orderCount } from './db';

async function noHorizontalScroll(page: Page) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(sw, 'página não pode ter rolagem horizontal').toBeLessThanOrEqual(iw);
}

test.beforeEach(async ({ page }) => {
  await db.query(`UPDATE store_settings SET open_mode = 'force_open', min_order_cents = 0, delivery_fee_mode = 'neighborhood'`);
  // Produtos com estoque controlado são consumidos a cada execução; repõe para o teste não depender do histórico.
  await db.query(`UPDATE products SET stock_qty = 500 WHERE track_stock AND available AND name NOT LIKE 'Lanche esgotado%'`);
  // Bloqueia o ViaCEP nos testes para não depender de rede externa.
  await page.route('https://viacep.com.br/**', (r) => r.fulfill({ json: { erro: true } }));
});


test('cardápio carrega, sem rolagem horizontal, com indisponível bloqueado', async ({ page }) => {
  await page.goto('/cardapio');
  await expect(page.getByRole('img', { name: 'Rangasso' })).toBeVisible();
  await expect(page.getByText('Aberto agora')).toBeVisible();
  await expect(page.getByRole('heading', { name: '[TESTE] Lanches' })).toBeVisible();
  await noHorizontalScroll(page);
  await page.getByRole('button', { name: /Lanche esgotado/ }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Indisponível', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Fechar' }).click();
});

test('fluxo completo de pedido com adicionais, validações e clique duplo', async ({ page }) => {
  await page.goto('/cardapio');
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.getByRole('button', { name: /Burger da Casa/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /Adicionar/ }).click();
  await expect(dialog.getByText('Escolha uma opção para continuar.')).toBeVisible();
  await dialog.getByText('Ao ponto').click();
  await dialog.getByText('Bacon').click();
  await dialog.getByRole('button', { name: 'Aumentar' }).click();
  // 2 x (32,90 + 5,00) = 75,80
  await expect(dialog.getByRole('button', { name: /Adicionar · R\$\s75,80/ })).toBeVisible();
  await dialog.getByRole('button', { name: /Adicionar/ }).click();

  await page.getByRole('button', { name: /Refrigerante lata/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Adicionar/ }).click();

  await expect(page.getByRole('button', { name: /Ver carrinho/ })).toContainText('3');
  await noHorizontalScroll(page);
  await page.getByRole('button', { name: /Ver carrinho/ }).click();
  await expect(page.getByRole('dialog').getByText('R$ 82,80')).toBeVisible();
  await page.getByRole('button', { name: 'Finalizar pedido' }).click();

  await expect(page.getByRole('heading', { name: 'Finalizar pedido' })).toBeVisible();
  await noHorizontalScroll(page);
  await page.getByRole('button', { name: /Enviar pedido/ }).click();
  await expect(page.getByText('Informe seu nome.')).toBeVisible();
  await expect(page.getByText('Selecione o bairro.')).toBeVisible();

  await page.getByLabel('Nome').fill('Cliente E2E');
  await page.getByLabel('Telefone (WhatsApp)').pressSequentially('11987654321');
  await expect(page.getByLabel('Telefone (WhatsApp)')).toHaveValue('(11) 98765-4321');
  await page.getByLabel('Rua').fill('Rua do Teste');
  await page.getByLabel('Número').fill('123');
  await page.getByLabel('Bairro').selectOption({ label: 'Bairro Teste B — taxa R$\u00a08,00' });
  await expect(page.locator('.totals .total')).toContainText('R$ 90,80');
  await page.getByText('Dinheiro').click();
  await page.getByText('Preciso de troco').click();
  await page.getByLabel('Troco para quanto?').pressSequentially('5000');
  await page.getByText(/Concordo com o uso/).click();
  await page.getByRole('button', { name: /Enviar pedido/ }).click();
  await expect(page.getByText(/O valor precisa ser maior que o total/)).toBeVisible();
  await page.getByLabel('Troco para quanto?').fill('');
  await page.getByLabel('Troco para quanto?').pressSequentially('10000');
  await expect(page.getByLabel('Troco para quanto?')).toHaveValue(/100,00/);

  const before = await orderCount();
  const btn = page.getByRole('button', { name: /Enviar pedido/ });
  await btn.dblclick();
  await expect(page.getByText(/Recebemos seu pedido/)).toBeVisible();
  await expect(page.locator('.order-number')).toHaveText(/#\d+/);
  expect(await orderCount()).toBe(before + 1);
  await expect(page.locator('.totals .total')).toContainText('R$ 90,80');
  await noHorizontalScroll(page);

  const number = Number((await page.locator('.order-number').textContent())!.replace('#', ''));
  const o = (await db.query('SELECT total_cents, delivery_fee_cents, change_for_cents, customer_phone FROM orders WHERE number = $1', [number])).rows[0];
  expect(o).toEqual({ total_cents: 9080, delivery_fee_cents: 800, change_for_cents: 10000, customer_phone: '11987654321' });
});

test('loja fechada mostra aviso e não deixa finalizar', async ({ page }) => {
  await db.query(`UPDATE store_settings SET open_mode = 'force_closed'`);
  await page.goto('/cardapio');
  await expect(page.getByText('Fechado', { exact: true })).toBeVisible();
  await expect(page.getByText(/os pedidos estão pausados/)).toBeVisible();
  await page.getByRole('button', { name: /Batata frita/ }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Loja fechada' })).toBeDisabled();
  await db.query(`UPDATE store_settings SET open_mode = 'force_open'`);
});

test('queda de conexão no envio não duplica o pedido ao reenviar', async ({ page }) => {
  await page.goto('/cardapio');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: /Batata frita/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Adicionar/ }).click();
  await page.getByRole('button', { name: /Ver carrinho/ }).click();
  await page.getByRole('button', { name: 'Finalizar pedido' }).click();
  await page.getByLabel('Nome').fill('Rede Instável');
  await page.getByLabel('Telefone (WhatsApp)').pressSequentially('21999998888');
  await page.getByLabel('Rua').fill('Rua B');
  await page.getByLabel('Número').fill('1');
  await page.getByLabel('Bairro').selectOption({ index: 1 });
  await page.getByText('Pix').click();
  await page.getByText(/Concordo com o uso/).click();

  const before = await orderCount();
  // 1ª tentativa: o pedido chega ao servidor, mas a resposta "se perde".
  let first = true;
  await page.route('**/api/public/orders', async (route) => {
    if (first) {
      first = false;
      await route.fetch(); // servidor processa
      await route.abort('connectionreset');
    } else {
      await route.continue();
    }
  });
  await page.getByRole('button', { name: /Enviar pedido/ }).click();
  await expect(page.getByText(/A conexão caiu durante o envio/)).toBeVisible();
  expect(await orderCount()).toBe(before + 1);
  await page.getByRole('button', { name: /Enviar pedido/ }).click();
  await expect(page.getByText(/Recebemos seu pedido/)).toBeVisible();
  expect(await orderCount()).toBe(before + 1);
});

test('CEP preenche rua e bairro; bairro fora da lista sai com taxa a combinar', async ({ page }) => {
  await page.route('https://viacep.com.br/**', (r) =>
    r.fulfill({ json: { cep: '01310-100', logradouro: 'Avenida do CEP', bairro: 'Jardim do CEP', localidade: 'São Paulo', uf: 'SP' } }));
  await page.goto('/cardapio');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: /Batata frita/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Adicionar/ }).click();
  await page.getByRole('button', { name: /Ver carrinho/ }).click();
  await page.getByRole('button', { name: 'Finalizar pedido' }).click();
  await page.getByLabel('Nome').fill('Cliente CEP');
  await page.getByLabel('Telefone (WhatsApp)').pressSequentially('11988887777');
  await page.locator('#f-cep').pressSequentially('01310100');
  await expect(page.locator('#f-street')).toHaveValue('Avenida do CEP');
  await expect(page.locator('#f-neighborhoodId option:checked')).toHaveText(/Jardim do CEP.* — taxa a combinar/);
  await expect(page.locator('.totals')).toContainText('a combinar');
  await page.getByLabel('Número').fill('50');
  await page.getByText('Pix').click();
  await page.getByText(/Concordo com o uso/).click();
  await page.getByRole('button', { name: /Enviar pedido/ }).click();
  await expect(page).toHaveURL(/\/cardapio\/pedido\//);
  await expect(page.locator('.totals')).toContainText('a combinar');
  const hood = (await db.query(`SELECT fee_pending, fee_cents FROM neighborhoods WHERE name = 'Jardim do CEP'`)).rows[0];
  expect(hood).toEqual({ fee_pending: true, fee_cents: 0 });
});

test('taxa por km: calcula pela distância do endereço até a loja', async ({ page }) => {
  await page.route('https://viacep.com.br/**', (r) =>
    r.fulfill({ json: { cep: '01310-100', logradouro: 'Avenida do CEP', bairro: 'Jardim do CEP', localidade: 'São Paulo', uf: 'SP' } }));
  // Loja localizada, faixas cadastradas e o endereço do cliente já no cache do mapa (o teste não usa a internet).
  const store = (await db.query('SELECT store_id FROM store_settings LIMIT 1')).rows[0].store_id;
  await db.query(`UPDATE store_settings SET delivery_fee_mode = 'distance', store_lat = -23.55, store_lng = -46.63`);
  await db.query('DELETE FROM delivery_distance_tiers WHERE store_id = $1', [store]);
  await db.query('INSERT INTO delivery_distance_tiers (store_id, max_km, fee_cents) VALUES ($1, 2, 500), ($1, 5, 990)', [store]);
  const key = JSON.stringify({ street: '50 Avenida do CEP', city: 'Sao Paulo', state: 'SP', country: 'Brasil' }).toLowerCase();
  await db.query(`INSERT INTO geocode_cache (query_key, lat, lng, label) VALUES ($1, -23.523, -46.63, 'teste')
                  ON CONFLICT (query_key) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, created_at = now()`, [key]);
  try {
    await page.goto('/cardapio');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.getByRole('button', { name: /Batata frita/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Adicionar/ }).click();
    await page.getByRole('button', { name: /Ver carrinho/ }).click();
    await page.getByRole('button', { name: 'Finalizar pedido' }).click();
    await page.locator('#f-cep').pressSequentially('01310100');
    await expect(page.locator('#f-city')).toHaveValue('São Paulo');
    await page.getByLabel('Número').fill('50');
    await expect(page.locator('.totals')).toContainText('(3,0 km)');
    await expect(page.locator('.totals')).toContainText('R$ 9,90');
  } finally {
    await db.query(`UPDATE store_settings SET delivery_fee_mode = 'neighborhood'`);
  }
});

test('cliente vê seus pedidos ao voltar e avalia com estrelas, comentário e foto', async ({ page, request }) => {
  const prod = (await db.query(`SELECT id FROM products WHERE name = 'Batata frita (teste)'`)).rows[0].id;
  const hood = (await db.query(`SELECT id FROM neighborhoods WHERE active ORDER BY name LIMIT 1`)).rows[0].id;
  const res = await request.post('/api/public/orders', {
    data: {
      idempotencyKey: `e2e-review-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      customer: { name: 'Avaliadora E2E', phone: '(11) 97777-6666' },
      address: { street: 'Rua das Estrelas', number: '5', neighborhoodId: hood },
      payment: { method: 'pix' }, items: [{ productId: prod, quantity: 1 }], acceptPrivacy: true,
    },
  });
  expect(res.status()).toBe(201);
  const { token, number } = await res.json();

  // Abrir o link do pedido guarda o pedido neste aparelho.
  await page.goto(`/cardapio/pedido/${token}`);
  await expect(page.getByText(`#${number}`)).toBeVisible();
  await page.goto('/cardapio');
  await expect(page.locator('.recent-order', { hasText: `Pedido #${number}` })).toContainText('Acompanhar');

  await db.query(`UPDATE orders SET status = 'completed' WHERE public_token = $1`, [token]);
  await page.reload();
  await page.locator('.recent-order', { hasText: `Pedido #${number}` }).click();
  await expect(page.getByRole('heading', { name: 'Como foi seu pedido?' })).toBeVisible();
  await page.getByRole('button', { name: 'Enviar avaliação' }).click();
  await expect(page.getByText('Escolha de 1 a 5 estrelas.')).toBeVisible();
  await page.getByRole('radio', { name: /^5 estrelas/ }).click();
  await page.getByLabel(/Comentário/).fill('Batata sequinha, chegou quente!');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAPUlEQVRIie3VQQ0AMAwCwHnCE/LRMBnb45L+mzSUO2uezLG4Tj3hineqApnKDCSKxWCxWBwWg8VicV+xeAHPJik68N4GLgAAAABJRU5ErkJggg==', 'base64');
  await page.locator('#f-review-photo').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: 'Enviar avaliação' }).click();
  await expect(page.getByRole('heading', { name: 'Sua avaliação' })).toBeVisible();
  await expect(page.getByRole('img', { name: '5 de 5 estrelas' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Foto enviada na avaliação' })).toBeVisible();

  await page.goto('/cardapio/pedidos');
  await expect(page.locator('.my-order', { hasText: `Pedido #${number}` })).toContainText('Você avaliou: ★★★★★');
});
