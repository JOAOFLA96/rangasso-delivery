import { expect, test, type Page } from '@playwright/test';
import { db } from './db';

const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'dono@teste.local';
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'devpassword123';

async function login(page: Page) {
  await page.goto('/admin');
  await page.getByLabel('E-mail').fill(EMAIL);
  await page.getByLabel('Senha').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('link', { name: 'Pedidos' })).toBeVisible();
}

test.beforeEach(async () => {
  await db.query(`DELETE FROM label_prints`);
  await db.query(`DELETE FROM print_job_events WHERE job_id IN (SELECT id FROM print_jobs WHERE kind = 'label')`);
  await db.query(`DELETE FROM print_jobs WHERE kind = 'label'`);
  await db.query(`DELETE FROM label_products`);
});

test('etiquetas: cadastra prazo, imprime 50x30 mm com lote e dá baixa no vencimento', async ({ page }, info) => {
  await page.addInitScript(() => {
    (window as any).__prints = 0;
    window.print = () => { (window as any).__prints++; };
  });
  await login(page);
  await page.getByRole('link', { name: 'Etiquetas' }).click();
  await expect(page).toHaveURL(/\/admin\/etiquetas\/imprimir/);

  // Cadastro do produto com 3 dias resfriado e 30 dias congelado.
  await page.getByLabel('Etiquetas', { exact: true }).getByRole('link', { name: 'Produtos e prazos' }).click();
  await page.getByRole('button', { name: '+ Produto' }).click();
  await page.getByLabel('Nome (sai na etiqueta)').fill('Frango desfiado');
  await page.getByLabel('Grupo (opcional)').fill('Carnes');
  await page.getByLabel('Prazo Resfriado').fill('3');
  await page.getByLabel('Prazo Congelado').fill('30');
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByRole('cell', { name: 'Frango desfiado' })).toBeVisible();

  // Impressão: a validade é calculada na tela e o lote vem do servidor.
  await page.getByLabel('Etiquetas', { exact: true }).getByRole('link', { name: 'Imprimir' }).click();
  await page.getByLabel('Quantidade / peso (opcional)').fill('2 kg');
  await expect(page.locator('.lbl-preview .lbl-name')).toHaveText('Frango desfiado');
  await expect(page.locator('.lbl-computed')).toContainText('(3 dias)');
  await page.getByRole('button', { name: 'Mais' }).click();
  await page.getByRole('button', { name: 'Mais' }).click();
  await page.getByRole('button', { name: 'Impressora de etiqueta 50x30' }).click();
  await page.getByRole('button', { name: 'Imprimir 3 etiquetas' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__prints)).toBe(1);

  const lot = (await db.query(`SELECT lot FROM label_prints`)).rows[0].lot as string;
  expect(lot).toMatch(/^\d{6}-001$/);

  // O PDF gerado com as regras de impressão tem 1 página por etiqueta, no tamanho 50 x 30 mm.
  await page.evaluate(() => document.body.classList.add('printing-labels'));
  await expect(page.locator('#label-page-style')).toHaveCount(1);
  {
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    const text = pdf.toString('latin1');
    const pages = text.match(/\/Type\s*\/Page[^s]/g) ?? [];
    expect(pages.length).toBe(3);
    const box = text.match(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/);
    // 50 mm = 141,7 pt; 30 mm = 85 pt.
    expect(Math.round(Number(box![1]))).toBe(142);
    expect(Math.round(Number(box![2]))).toBe(85);
    await info.attach('etiquetas.pdf', { body: pdf, contentType: 'application/pdf' });
  }
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));

  // Vencimentos: aparece no prazo e recebe baixa como usado.
  await page.getByLabel('Etiquetas', { exact: true }).getByRole('link', { name: 'Vencimentos' }).click();
  await expect(page.getByRole('cell', { name: lot })).toBeVisible();
  await expect(page.getByText('No prazo')).toBeVisible();
  await page.getByRole('button', { name: 'Usado', exact: true }).click();
  await page.getByRole('button', { name: 'Dar baixa' }).click();
  await expect(page.getByText('Nenhuma etiqueta ativa')).toBeVisible();
  expect((await db.query(`SELECT status FROM label_prints`)).rows[0].status).toBe('used');
});

test('etiquetas pela Epson do caixa: vai para a fila do agente, sem abrir a impressão do navegador', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__prints = 0;
    window.print = () => { (window as any).__prints++; };
  });
  await login(page);
  await page.goto('/admin/etiquetas/imprimir');
  await page.getByLabel('Nome do produto').fill('Cebola caramelizada');
  await page.locator('input[type="datetime-local"]').nth(1).fill('2030-01-10T10:00');
  await page.getByRole('button', { name: 'Epson do caixa (bobina)' }).click();
  await page.getByRole('button', { name: 'Mais' }).click();
  await page.getByRole('button', { name: 'Imprimir 2 etiquetas' }).click();
  await expect(page.getByText(/enviado para a Epson/)).toBeVisible();
  const job = (await db.query(`SELECT kind, copies, payload FROM print_jobs WHERE kind = 'label'`)).rows[0];
  expect(job).toMatchObject({ kind: 'label', copies: 2 });
  expect(job.payload.label.productName).toBe('Cebola caramelizada');
  expect(await page.evaluate(() => (window as any).__prints)).toBe(0);
});

test('teste de alinhamento: 5 etiquetas e correção do avanço muda a altura da página', async ({ page }) => {
  await page.addInitScript(() => {
    window.print = () => {};
    localStorage.setItem('rg_label_print_prefs', JSON.stringify({ mode: 'gap', gapMm: 4, marginMm: 1.5, offsetXmm: 0, offsetYmm: 0, pitchAdjustMm: -0.5 }));
  });
  await login(page);
  await page.goto('/admin/etiquetas/ajustes');
  await expect(page.getByText('29,5 mm')).toBeVisible();
  await page.getByRole('button', { name: 'Imprimir teste (5 etiquetas)' }).click();
  await expect(page.locator('#label-page-style')).toHaveCount(1);
  await page.evaluate(() => document.body.classList.add('printing-labels'));
  const text = (await page.pdf({ preferCSSPageSize: true, printBackground: true })).toString('latin1');
  expect((text.match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(5);
  const box = text.match(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/);
  // 29,5 mm = 83,6 pt.
  expect(Math.round(Number(box![2]))).toBe(84);
});
