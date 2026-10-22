import sharp from 'sharp';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seed, makeApp, orderBody, loginAs, pool, type Fixture } from './helpers.js';
import { resetVapidCache, setPushSender } from '../src/services/push.js';

let app: Awaited<ReturnType<typeof makeApp>>;
let f: Fixture;
let sent: { endpoint: string; payload: any }[];
let failWith: number | null;

beforeEach(async () => {
  await resetDb();
  resetVapidCache();
  f = await seed();
  app ??= await makeApp();
  sent = [];
  failWith = null;
  setPushSender(async (sub, payload) => {
    if (failWith) throw Object.assign(new Error('push falhou'), { statusCode: failWith });
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
  });
});
afterEach(() => setPushSender(null));
afterAll(async () => {
  await app.close();
});

const newOrder = async () => (await app.inject({ method: 'POST', url: '/api/public/orders', payload: orderBody(f) })).json() as { number: number; token: string };
const orderId = async (token: string) => (await pool.query('SELECT id FROM orders WHERE public_token = $1', [token])).rows[0].id as string;
const sub = (n = 1) => ({ endpoint: `https://push.exemplo.com/assinatura-${n}`, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });
async function setStatus(token: string, status: string, note = '') {
  const h = await loginAs(app, 'gerente@t.local');
  const res = await app.inject({ method: 'POST', url: `/api/admin/orders/${await orderId(token)}/status`, headers: h, payload: { status, note } });
  expect(res.statusCode).toBe(200);
  await new Promise((r) => setTimeout(r, 50)); // envio do aviso não bloqueia a resposta
}
function multipart(fields: Record<string, string>, file?: { name: string; type: string; data: Buffer }) {
  const boundary = '----rangassoTeste';
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    chunks.push(file.data, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('avisos push do pedido', () => {
  it('chave pública é gerada uma vez e reaproveitada', async () => {
    const a = (await app.inject({ method: 'GET', url: '/api/public/push/key' })).json().publicKey;
    resetVapidCache();
    const b = (await app.inject({ method: 'GET', url: '/api/public/push/key' })).json().publicKey;
    expect(a).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(b).toBe(a);
  });

  it('avisa quando o pedido é aceito e quando sai para entrega', async () => {
    const o = await newOrder();
    expect((await app.inject({ method: 'POST', url: `/api/public/orders/${o.token}/push`, payload: { ...sub(), endpoint: 'http://inseguro' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/public/orders/${o.token}/push`, payload: sub() })).statusCode).toBe(200);
    await setStatus(o.token, 'confirmed');
    await setStatus(o.token, 'preparing'); // sem aviso
    await setStatus(o.token, 'out_for_delivery');
    expect(sent.map((s) => s.payload.title)).toEqual([`Pedido #${o.number} aceito ✅`, `Pedido #${o.number} saiu para entrega 🛵`]);
    expect(sent[0].payload.url).toBe(`/cardapio/pedido/${o.token}`);
    await setStatus(o.token, 'completed');
    expect(sent[2].payload.title).toBe(`Pedido #${o.number} entregue`);
    expect((await pool.query('SELECT count(*)::int c FROM push_subscriptions')).rows[0].c).toBe(0); // encerrado: inscrições apagadas
    expect((await app.inject({ method: 'POST', url: `/api/public/orders/${o.token}/push`, payload: sub() })).json().error.code).toBe('order_closed');
  });

  it('aparelho que cancelou a inscrição é removido', async () => {
    const o = await newOrder();
    await app.inject({ method: 'POST', url: `/api/public/orders/${o.token}/push`, payload: sub(1) });
    failWith = 410;
    await setStatus(o.token, 'confirmed');
    expect((await pool.query('SELECT count(*)::int c FROM push_subscriptions')).rows[0].c).toBe(0);
  });
});

describe('avaliação do pedido', () => {
  it('só depois de entregue; uma por pedido; com foto; aparece no painel', async () => {
    const o = await newOrder();
    const review = (body: ReturnType<typeof multipart>) => app.inject({ method: 'POST', url: `/api/public/orders/${o.token}/review`, ...body });
    expect((await review(multipart({ rating: '5' }))).json().error.code).toBe('not_delivered');
    await setStatus(o.token, 'completed');
    let st = (await app.inject({ method: 'GET', url: `/api/public/orders/${o.token}` })).json();
    expect(st).toMatchObject({ canReview: true, review: null });

    expect((await review(multipart({ rating: '7' }))).statusCode).toBe(400);
    const png = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#c33' } }).png().toBuffer();
    const ok = await review(multipart({ rating: '4', comment: 'Lanche ótimo, chegou quente!' }, { name: 'foto.png', type: 'image/png', data: png }));
    expect(ok.statusCode).toBe(201);
    expect((await review(multipart({ rating: '5' }))).json().error.code).toBe('already_reviewed');

    st = (await app.inject({ method: 'GET', url: `/api/public/orders/${o.token}` })).json();
    expect(st).toMatchObject({ canReview: false, review: { rating: 4, comment: 'Lanche ótimo, chegou quente!' } });
    const img = await app.inject({ method: 'GET', url: st.review.photoUrl });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/webp');
    expect((await sharp(img.rawPayload).metadata()).width).toBe(1200); // redimensionada

    const h = await loginAs(app, 'atendente@t.local');
    const list = (await app.inject({ method: 'GET', url: '/api/admin/reviews', headers: h })).json();
    expect(list.summary).toMatchObject({ count: 1, average: 4, distribution: { 4: 1 } });
    expect(list.reviews[0]).toMatchObject({ rating: 4, orderNumber: o.number, hidden: false });
    expect((await app.inject({ method: 'POST', url: `/api/admin/reviews/${list.reviews[0].id}/visibility`, headers: h, payload: { hidden: true } })).statusCode).toBe(403);
    const m = await loginAs(app, 'gerente@t.local');
    expect((await app.inject({ method: 'POST', url: `/api/admin/reviews/${list.reviews[0].id}/visibility`, headers: m, payload: { hidden: true } })).statusCode).toBe(200);
  });

  it('arquivo que não é imagem é recusado', async () => {
    const o = await newOrder();
    await setStatus(o.token, 'completed');
    const res = await app.inject({ method: 'POST', url: `/api/public/orders/${o.token}/review`, ...multipart({ rating: '5' }, { name: 'x.png', type: 'image/png', data: Buffer.from('não é imagem') }) });
    expect(res.json().error.code).toBe('invalid_image');
    expect((await pool.query('SELECT count(*)::int c FROM order_reviews')).rows[0].c).toBe(0);
  });
});
