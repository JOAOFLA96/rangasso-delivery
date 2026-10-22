import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { db } from './db';

const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'dono@teste.local';
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'devpassword123';

async function login(page: Page) {
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin\/login/);
  await page.getByLabel('E-mail').fill(EMAIL);
  await page.getByLabel('Senha').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('link', { name: 'Pedidos' })).toBeVisible();
}

async function noHorizontalScroll(page: Page) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(sw).toBeLessThanOrEqual(iw);
}

async function placeOrder(request: APIRequestContext, name: string) {
  const menu = await (await request.get('/api/public/menu')).json();
  const store = await (await request.get('/api/public/store')).json();
  const fries = menu.categories.flatMap((c: any) => c.products).find((p: any) => p.name.startsWith('Batata frita'));
  const res = await request.post('/api/public/orders', {
    data: {
      idempotencyKey: `e2e${Date.now()}${Math.random().toString(36).slice(2)}`,
      customer: { name, phone: '11912345678' },
      address: { street: 'Rua Admin', number: '5', neighborhoodId: store.neighborhoods[0].id },
      payment: { method: 'card' },
      items: [{ productId: fries.id, quantity: 1, addonIds: [] }],
      acceptPrivacy: true,
    },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

test.beforeEach(async () => {
  await db.query(`UPDATE store_settings SET open_mode = 'force_open', min_order_cents = 0`);
  await db.query(`UPDATE admin_users SET failed_logins = 0, locked_until = NULL`);
});

test('rotas do painel exigem login e senha errada é recusada', async ({ page }) => {
  await page.goto('/admin/configuracoes/cardapio');
  await expect(page).toHaveURL(/\/admin\/login/);
  await page.getByLabel('E-mail').fill(EMAIL);
  await page.getByLabel('Senha').fill('senha-errada');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByText('E-mail ou senha incorretos.')).toBeVisible();
});

test('pedido novo aparece em tempo real e o status avança', async ({ page, request }) => {
  await login(page);
  await expect(page.getByText('Ao vivo')).toBeVisible();
  await noHorizontalScroll(page);
  const name = `Tempo Real ${Date.now()}`;
  const order = await placeOrder(request, name);
  // Sem recarregar a página:
  const card = page.getByRole('button', { name: new RegExp(`#${order.number}\\b`) });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();
  await expect(page.getByRole('heading', { name: `Pedido #${order.number}` })).toBeVisible();
  await expect(page.locator('.a-detail').getByText(name)).toBeVisible();
  await noHorizontalScroll(page);
  await page.getByRole('button', { name: 'Confirmar pedido' }).click();
  await expect(page.locator('.a-detail-head .pill')).toHaveText('Confirmado');
  await page.getByRole('button', { name: 'Iniciar preparo' }).click();
  await expect(page.locator('.a-detail-head .pill')).toHaveText('Em preparo');
  // cliente vê o novo status
  const pub = await (await request.get(`/api/public/orders/${order.token}`)).json();
  expect(pub.status).toBe('preparing');
  // histórico com o usuário
  await expect(page.locator('.a-history')).toContainText('Em preparo');

  // reimpressão com motivo
  await page.getByRole('button', { name: /Imprimir comanda|Reimprimir comanda/ }).click();
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible()) {
    await dialog.getByLabel('Motivo (opcional)').fill('teste e2e');
    await dialog.getByRole('button', { name: 'Reimprimir' }).click();
    await expect(page.locator('.a-jobs')).toContainText('Reimpressão nº 1');
  }

  // cancelamento exige motivo
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  const cancel = page.getByRole('dialog');
  await expect(cancel.getByRole('button', { name: 'Cancelar pedido' })).toBeDisabled();
  await cancel.getByLabel('Motivo do cancelamento').fill('Teste automatizado');
  await cancel.getByRole('button', { name: 'Cancelar pedido' }).click();
  await expect(page.getByText('Cancelado: Teste automatizado')).toBeVisible();
});

test('alterações do cardápio no painel aparecem no cardápio público', async ({ page, context }) => {
  await login(page);
  await page.getByRole('link', { name: 'Configurações' }).click();
  await expect(page.getByRole('heading', { name: 'Cardápio', exact: true })).toBeVisible();
  await noHorizontalScroll(page);
  const row = page.locator('.a-prod', { hasText: 'Batata frita (teste)' });
  await row.getByRole('button', { name: 'Editar' }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('Preço (R$)', { exact: true }).fill('31,50');
  await modal.getByRole('button', { name: 'Salvar produto' }).click();
  await expect(page.getByText('Produto salvo')).toBeVisible();
  await modal.getByRole('button', { name: 'Fechar' }).click();

  const pub = await context.newPage();
  await pub.goto('/cardapio');
  await expect(pub.getByRole('button', { name: /Batata frita \(teste\), R\$\s31,50/ })).toBeVisible();

  // esgotar pelo atalho
  await row.getByRole('switch').click({ force: true });
  await expect(page.getByText(/marcado como esgotado/)).toBeVisible();
  await pub.reload();
  await expect(pub.getByRole('button', { name: /Batata frita \(teste\).*indisponível/ })).toBeVisible();
  await row.getByRole('switch').click({ force: true });
  await expect(page.getByText(/Batata frita \(teste\) disponível/)).toBeVisible();

  // volta o preço original
  await row.getByRole('button', { name: 'Editar' }).click();
  await page.getByRole('dialog').getByLabel('Preço (R$)', { exact: true }).fill('29,00');
  await page.getByRole('dialog').getByRole('button', { name: 'Salvar produto' }).click();
  await expect(page.getByText('Produto salvo')).toBeVisible();
});

test('taxa do bairro e telas de configuração', async ({ page, context }) => {
  await login(page);
  await page.goto('/admin/configuracoes/entrega');
  await expect(page.getByRole('heading', { name: 'Entrega e horários' })).toBeVisible();
  await noHorizontalScroll(page);
  const row = page.locator('tr', { hasText: 'Bairro Teste A' });
  await row.getByRole('button', { name: 'Editar' }).click();
  await page.getByRole('dialog').getByLabel('Taxa de entrega (R$)').fill('6,50');
  await page.getByRole('dialog').getByRole('button', { name: 'Salvar' }).click();
  await expect(row).toContainText('6,50');
  const store = await (await context.request.get('/api/public/store')).json();
  expect(store.neighborhoods.find((n: any) => n.name === 'Bairro Teste A').feeCents).toBe(650);
  await row.getByRole('button', { name: 'Editar' }).click();
  await page.getByRole('dialog').getByLabel('Taxa de entrega (R$)').fill('5,00');
  await page.getByRole('dialog').getByRole('button', { name: 'Salvar' }).click();
  await expect(row).toContainText('5,00');

  for (const [path, heading] of [['impressora', 'Impressora'], ['loja', 'Dados da loja'], ['usuarios', 'Usuários'], ['auditoria', 'Auditoria'], ['conta', 'Minha conta']]) {
    await page.goto(`/admin/configuracoes/${path}`);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await noHorizontalScroll(page);
  }
  await expect(page.locator('.a-table, .card').first()).toBeVisible();
});

test('histórico com filtros e logout', async ({ page, request }) => {
  const o = await placeOrder(request, 'Filtro Histórico');
  await login(page);
  await page.getByRole('tab', { name: 'Histórico' }).click();
  await page.getByLabel('Buscar').fill(String(o.number));
  await expect(page.locator('.a-order-card')).toHaveCount(1);
  await expect(page.locator('.a-order-card')).toContainText(`#${o.number}`);
  await page.getByLabel('Buscar').fill('');
  await page.getByLabel('Pagamento').selectOption('card');
  await expect(page.locator('.a-order-card').first()).toContainText('Cartão');
  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page).toHaveURL(/\/admin\/login/);
  await page.goto('/admin/pedidos');
  await expect(page).toHaveURL(/\/admin\/login/);
});

test('avaliações aparecem no painel', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Avaliações' }).click();
  await expect(page.getByRole('heading', { name: 'Avaliações dos clientes' })).toBeVisible();
  await noHorizontalScroll(page);
});
