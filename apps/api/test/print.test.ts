import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resetDb, seed, makeApp, orderBody, loginAs, pool, type Fixture } from './helpers.js';

let app: Awaited<ReturnType<typeof makeApp>>;
let f: Fixture;
let admin: Record<string, string>;
let agent: Record<string, string>;
let deviceId: string;

beforeEach(async () => {
  await resetDb();
  f = await seed();
  app ??= await makeApp();
  admin = await loginAs(app, 'dono@t.local');
  const d = (await app.inject({ method: 'POST', url: '/api/admin/printer/devices', headers: admin, payload: { name: 'PC do caixa' } })).json();
  deviceId = d.id;
  agent = { authorization: `Bearer ${d.token}` };
});
afterAll(async () => {
  await app.close();
});

const claim = async (h = agent) => app.inject({ method: 'GET', url: '/api/agent/jobs?wait=0', headers: h });
const report = (id: string, status: string, detail = '', h = agent) =>
  app.inject({ method: 'POST', url: `/api/agent/jobs/${id}/status`, headers: h, payload: { status, detail } });
const newOrder = async () => (await app.inject({ method: 'POST', url: '/api/public/orders', payload: orderBody(f) })).json();
const orderPrint = async (n: number) => (await pool.query('SELECT print_status FROM orders WHERE number = $1', [n])).rows[0].print_status;

describe('agente de impressão', () => {
  it('atualização automática: informa a versão publicada e entrega o agent.cjs só com credencial', async () => {
    const content = readFileSync(new URL('./fixtures/agent-bundle/agent.cjs', import.meta.url));
    const info = await app.inject({ method: 'GET', url: '/api/agent/update', headers: agent });
    expect(info.json()).toEqual({ version: '9.9.9', sha256: createHash('sha256').update(content).digest('hex'), size: content.length });
    const dl = await app.inject({ method: 'GET', url: '/api/agent/update/agent.cjs', headers: agent });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(content)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/agent/update/agent.cjs' })).statusCode).toBe(401);
  });

  it('sem credencial válida não acessa nada', async () => {
    expect((await claim({ authorization: 'Bearer rgd_invalido_invalido_invalido' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/agent/jobs?wait=0' })).statusCode).toBe(401);
  });

  it('token só existe como hash no banco', async () => {
    const row = (await pool.query('SELECT token_hash, token_prefix FROM print_devices WHERE id = $1', [deviceId])).rows[0];
    expect(agent.authorization).not.toContain(row.token_hash);
    expect(row.token_hash).toHaveLength(64);
  });

  it('fluxo completo: fila -> agente -> enviando -> impresso', async () => {
    const o = await newOrder();
    expect(await orderPrint(o.number)).toBe('pending');
    const jobs = (await claim()).json().jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].kind).toBe('original');
    expect(jobs[0].payload.order).toMatchObject({ number: o.number, totalCents: 7600, customerName: 'Cliente Teste' });
    expect(await orderPrint(o.number)).toBe('claimed');
    // outro claim não devolve o mesmo trabalho
    expect((await claim()).json().jobs).toHaveLength(0);
    await report(jobs[0].id, 'sending');
    expect(await orderPrint(o.number)).toBe('sending');
    await report(jobs[0].id, 'printed', 'ok');
    expect(await orderPrint(o.number)).toBe('printed');
    // relato repetido (reenvio após timeout) é aceito sem efeito
    expect((await report(jobs[0].id, 'printed')).statusCode).toBe(200);
    const events = (await pool.query('SELECT event FROM print_job_events WHERE job_id = $1 ORDER BY id', [jobs[0].id])).rows.map((r) => r.event);
    expect(events).toEqual(['created', 'claimed', 'sending', 'printed']);
  });

  it('spooler do Windows: enviado não vira impresso automaticamente', async () => {
    const o = await newOrder();
    const [job] = (await claim()).json().jobs;
    await report(job.id, 'sending');
    await report(job.id, 'sent', 'spooler aceitou');
    expect(await orderPrint(o.number)).toBe('sent');
  });

  it('falha volta para a fila com intervalo progressivo', async () => {
    const o = await newOrder();
    const [job] = (await claim()).json().jobs;
    await report(job.id, 'failed', 'impressora sem papel');
    expect(await orderPrint(o.number)).toBe('failed');
    expect((await claim()).json().jobs).toHaveLength(0); // ainda dentro do intervalo
    await pool.query('UPDATE print_jobs SET next_attempt_at = now() WHERE id = $1', [job.id]);
    const again = (await claim()).json().jobs;
    expect(again[0]).toMatchObject({ id: job.id, attempt: 2 });
    const dev = (await pool.query('SELECT last_error FROM print_devices WHERE id = $1', [deviceId])).rows[0];
    expect(dev.last_error).toBe('impressora sem papel');
  });

  it('esgota tentativas e para de tentar sozinho', async () => {
    await newOrder();
    const [job] = (await claim()).json().jobs;
    await pool.query('UPDATE print_jobs SET attempts = max_attempts WHERE id = $1', [job.id]);
    await report(job.id, 'failed', 'offline');
    await pool.query('UPDATE print_jobs SET next_attempt_at = now() WHERE id = $1', [job.id]);
    expect((await claim()).json().jobs).toHaveLength(0);
    // humano manda tentar de novo
    expect((await app.inject({ method: 'POST', url: `/api/admin/print-jobs/${job.id}/resolve`, headers: admin, payload: { action: 'retry' } })).statusCode).toBe(200);
    expect((await claim()).json().jobs).toHaveLength(1);
  });

  it('agente some depois de reivindicar: trabalho volta para a fila sem duplicar', async () => {
    const o = await newOrder();
    const [job] = (await claim()).json().jobs;
    await pool.query(`UPDATE print_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [job.id]);
    const again = (await claim()).json().jobs;
    expect(again.map((j: any) => j.id)).toEqual([job.id]);
    expect(await orderPrint(o.number)).toBe('claimed');
  });

  it('agente some durante o envio: resultado incerto, sem reimpressão automática', async () => {
    const o = await newOrder();
    const [job] = (await claim()).json().jobs;
    await report(job.id, 'sending');
    await pool.query(`UPDATE print_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [job.id]);
    expect((await claim()).json().jobs).toHaveLength(0);
    expect(await orderPrint(o.number)).toBe('uncertain');
    // humano confere que saiu e marca como impresso
    await app.inject({ method: 'POST', url: `/api/admin/print-jobs/${job.id}/resolve`, headers: admin, payload: { action: 'mark_printed' } });
    expect(await orderPrint(o.number)).toBe('printed');
  });

  it('aviso atrasado do próprio agente esclarece o resultado incerto', async () => {
    const o = await newOrder();
    const [job] = (await claim()).json().jobs;
    expect(job.claimId).toBeTruthy();
    await report(job.id, 'sending');
    await pool.query(`UPDATE print_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [job.id]);
    await claim();
    expect(await orderPrint(o.number)).toBe('uncertain');
    expect((await report(job.id, 'sent', 'enviado antes da queda')).statusCode).toBe(200);
    expect(await orderPrint(o.number)).toBe('sent');
  });

  it('heartbeat devolve a configuração da impressora do painel', async () => {
    await pool.query(`UPDATE store_settings SET printer_connection = 'network', printer_host = '192.168.0.50', paper_columns = 42`);
    const r = await app.inject({ method: 'POST', url: '/api/agent/heartbeat', headers: agent, payload: { agentVersion: '1', printer: { mode: 'auto', target: '', online: null } } });
    expect(r.json().printer).toMatchObject({ connection: 'network', host: '192.168.0.50', port: 9100, columns: 42 });
  });

  it('reimpressão manual é registrada e numerada', async () => {
    const o = await newOrder();
    const [job] = (await claim()).json().jobs;
    await report(job.id, 'printed');
    const orderId = (await pool.query('SELECT id FROM orders WHERE number = $1', [o.number])).rows[0].id;
    const r = await app.inject({ method: 'POST', url: `/api/admin/orders/${orderId}/print`, headers: admin, payload: { reason: 'motoboy perdeu' } });
    expect(r.json()).toMatchObject({ kind: 'reprint', reprintNumber: 1 });
    const r2 = await app.inject({ method: 'POST', url: `/api/admin/orders/${orderId}/print`, headers: admin, payload: {} });
    expect(r2.json().reprintNumber).toBe(2);
    const jobs = (await claim()).json().jobs;
    expect(jobs.map((j: any) => [j.kind, j.reprintNumber])).toEqual([['reprint', 1], ['reprint', 2]]);
    const audit = (await pool.query(`SELECT action, data->>'reason' AS reason FROM audit_log WHERE action = 'print.reprint' ORDER BY id`)).rows;
    expect(audit[0]).toEqual({ action: 'print.reprint', reason: 'motoboy perdeu' });
  });

  it('impressão automática desligada: pedido aguarda impressão manual', async () => {
    await pool.query('UPDATE store_settings SET auto_print = false');
    const o = await newOrder();
    expect(await orderPrint(o.number)).toBe('not_queued');
    expect((await claim()).json().jobs).toHaveLength(0);
    const orderId = (await pool.query('SELECT id FROM orders WHERE number = $1', [o.number])).rows[0].id;
    const r = await app.inject({ method: 'POST', url: `/api/admin/orders/${orderId}/print`, headers: admin, payload: {} });
    expect(r.json().kind).toBe('original');
  });

  it('credencial revogada para de funcionar e libera o trabalho', async () => {
    await newOrder();
    const [job] = (await claim()).json().jobs;
    await app.inject({ method: 'POST', url: `/api/admin/printer/devices/${deviceId}/revoke`, headers: admin });
    expect((await claim()).statusCode).toBe(401);
    // novo agente pega o trabalho de volta
    const d2 = (await app.inject({ method: 'POST', url: '/api/admin/printer/devices', headers: admin, payload: { name: 'PC novo' } })).json();
    const jobs = (await claim({ authorization: `Bearer ${d2.token}` })).json().jobs;
    expect(jobs.map((j: any) => j.id)).toEqual([job.id]);
  });

  it('agente não pode relatar trabalho de outro agente', async () => {
    await newOrder();
    const [job] = (await claim()).json().jobs;
    const d2 = (await app.inject({ method: 'POST', url: '/api/admin/printer/devices', headers: admin, payload: { name: 'Outro' } })).json();
    const r = await report(job.id, 'printed', '', { authorization: `Bearer ${d2.token}` });
    expect(r.statusCode).toBe(409);
  });

  it('heartbeat e impressão de teste aparecem no painel', async () => {
    await app.inject({
      method: 'POST', url: '/api/agent/heartbeat', headers: agent,
      payload: { agentVersion: '0.1.0', printer: { mode: 'windows', target: 'EPSON TM-T20', online: true }, localQueue: 0 },
    });
    await app.inject({ method: 'POST', url: '/api/admin/printer/test', headers: admin });
    const st = (await app.inject({ method: 'GET', url: '/api/admin/printer/status', headers: admin })).json();
    expect(st.devices[0]).toMatchObject({ name: 'PC do caixa', online: true, agent_version: '0.1.0' });
    expect(st.queue[0]).toMatchObject({ kind: 'test', status: 'pending' });
  });

  it('long-poll acorda quando entra pedido novo', async () => {
    const pending = app.inject({ method: 'GET', url: '/api/agent/jobs?wait=10', headers: agent });
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    await newOrder();
    const res = await pending;
    expect(res.json().jobs).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('long-poll aberto antes da revogação não pega o pedido novo', async () => {
    const pending = app.inject({ method: 'GET', url: '/api/agent/jobs?wait=5', headers: agent });
    await new Promise((r) => setTimeout(r, 200));
    await app.inject({ method: 'POST', url: `/api/admin/printer/devices/${deviceId}/revoke`, headers: admin });
    const o = await newOrder();
    expect((await pending).json().jobs).toHaveLength(0);
    expect(await orderPrint(o.number)).toBe('pending');
  });

  it('long-poll acorda na hora da retentativa agendada', async () => {
    await newOrder();
    const [job] = (await claim()).json().jobs;
    await report(job.id, 'failed', 'Sem papel'); // próxima tentativa em 5 s
    const t0 = Date.now();
    const res = await app.inject({ method: 'GET', url: '/api/agent/jobs?wait=25', headers: agent });
    expect(res.json().jobs.map((j: any) => j.id)).toEqual([job.id]);
    expect(Date.now() - t0).toBeLessThan(8000);
  }, 15_000);
});

describe('etiquetas de validade pela Epson (agente)', () => {
  const printLabel = (extra: object = {}) => app.inject({
    method: 'POST', url: '/api/admin/labels/prints', headers: admin,
    payload: { productName: 'Molho da casa', storage: 'chilled', responsible: 'Carlos', handledAt: new Date(Date.now() - 60_000).toISOString(),
      manualExpiresAt: new Date(Date.now() + 48 * 3600_000).toISOString(), quantityText: '1 kg', copies: 3, target: 'agent', ...extra },
  });
  const setVersion = (v: string | null) => pool.query('UPDATE print_devices SET agent_version = $2 WHERE id = $1', [deviceId, v]);

  it('vira trabalho de impressão com os dados da etiqueta e só vai para agente 1.6.0 ou mais novo', async () => {
    const r = await printLabel();
    expect(r.statusCode, r.body).toBe(200);
    const { jobId, print } = r.json();
    expect(jobId).toBeTruthy();

    await setVersion('1.5.0');
    expect((await claim()).json().jobs).toEqual([]);
    await setVersion(null);
    expect((await claim()).json().jobs).toEqual([]);
    await setVersion('1.6.0');
    const jobs = (await claim()).json().jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: jobId, kind: 'label', copies: 3 });
    expect(jobs[0].payload.label).toMatchObject({ productName: 'Molho da casa', lot: print.lot, responsible: 'Carlos', quantityText: '1 kg', storage: 'chilled' });
    expect(jobs[0].payload.store.timezone).toBe('America/Sao_Paulo');
    expect((await report(jobId, 'printed')).statusCode).toBe(200);

    const queue = (await app.inject({ method: 'GET', url: '/api/admin/printer/status', headers: admin })).json().queue;
    expect(queue[0]).toMatchObject({ kind: 'label', status: 'printed', label_lot: print.lot, label_product: 'Molho da casa' });
  });

  it('agente antigo continua recebendo as comandas; navegador não cria trabalho; reimpressão mantém o lote', async () => {
    await setVersion('1.5.0');
    await printLabel();
    await newOrder();
    const jobs = (await claim()).json().jobs;
    expect(jobs.map((j: any) => j.kind)).toEqual(['original']);

    const browser = (await printLabel({ target: 'browser' })).json();
    expect(browser.jobId).toBeNull();
    const re = await app.inject({ method: 'POST', url: `/api/admin/labels/prints/${browser.print.id}/agent`, headers: admin, payload: { copies: 2 } });
    expect(re.statusCode, re.body).toBe(200);
    await setVersion('1.6.1');
    const labelJobs = (await claim()).json().jobs.filter((j: any) => j.id === re.json().jobId);
    expect(labelJobs[0]).toMatchObject({ kind: 'label', copies: 2 });
    expect(labelJobs[0].payload.label.lot).toBe(browser.print.lot);
  });
});

describe('etiquetas em TSPL na impressora de etiquetas (USB no PC de um agente)', () => {
  const setVersion = (id: string, v: string) => pool.query('UPDATE print_devices SET agent_version = $2 WHERE id = $1', [id, v]);
  const printerBody = (over: object = {}) => ({
    deviceId: deviceId, printerName: 'OIA-B381', widthMm: 50, heightMm: 30, gapMm: 4, speed: 2, density: 12, offsetXmm: 0, offsetYmm: 0.5, rotate: false, ...over,
  });

  it('sem configurar a impressora, avisa onde configurar', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/admin/labels/printer/test', headers: admin, payload: {} });
    expect(r.json().error.code).toBe('label_printer_missing');
  });

  it('atendente não muda a configuração; gerente/dono salva e o trabalho vai só para o agente escolhido', async () => {
    const staff = await loginAs(app, 'atendente@t.local');
    expect((await app.inject({ method: 'PUT', url: '/api/admin/labels/printer', headers: staff, payload: printerBody() })).statusCode).toBe(403);
    const saved = await app.inject({ method: 'PUT', url: '/api/admin/labels/printer', headers: admin, payload: printerBody() });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().printer).toMatchObject({ deviceId, printerName: 'OIA-B381', speed: 2, density: 12, gapMm: 4, offsetYmm: 0.5 });

    // Segundo agente (outro PC): não pode pegar a etiqueta TSPL destinada ao primeiro.
    const d2 = (await app.inject({ method: 'POST', url: '/api/admin/printer/devices', headers: admin, payload: { name: 'PC do escritório' } })).json();
    const agent2 = { authorization: `Bearer ${d2.token}` };
    await setVersion(deviceId, '1.6.0');
    await setVersion(d2.id, '1.6.0');

    const r = await app.inject({
      method: 'POST', url: '/api/admin/labels/prints', headers: staff,
      payload: { productName: 'Coxinha', storage: 'chilled', responsible: 'Ana', handledAt: new Date(Date.now() - 60_000).toISOString(),
        manualExpiresAt: new Date(Date.now() + 3600_000).toISOString(), copies: 4, target: 'tspl' },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect((await claim(agent2)).json().jobs).toEqual([]);
    const jobs = (await claim()).json().jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: 'label', copies: 4 });
    expect(jobs[0].payload.tspl).toEqual({ printerName: 'OIA-B381', widthMm: 50, heightMm: 30, gapMm: 4, speed: 2, density: 12, offsetXmm: 0, offsetYmm: 0.5, rotate: false });
    expect(jobs[0].payload.label.lot).toBe(r.json().print.lot);

    // Teste de calibração também vai para o mesmo agente, sem dados de etiqueta.
    const t = (await app.inject({ method: 'POST', url: '/api/admin/labels/printer/test', headers: staff, payload: { copies: 3 } })).json();
    expect((await claim(agent2)).json().jobs).toEqual([]);
    const tj = (await claim()).json().jobs[0];
    expect(tj).toMatchObject({ id: t.jobId, copies: 3 });
    expect(tj.payload.calibration).toBe(true);

    // Reimpressão pela impressora de etiquetas mantém o lote.
    const re = await app.inject({ method: 'POST', url: `/api/admin/labels/prints/${r.json().print.id}/agent`, headers: staff, payload: { mode: 'tspl' } });
    const rj = (await claim()).json().jobs.find((j: any) => j.id === re.json().jobId);
    expect(rj.payload.tspl.printerName).toBe('OIA-B381');
    expect(rj.payload.label.lot).toBe(r.json().print.lot);

    // Comandas continuam indo para qualquer agente.
    await newOrder();
    expect((await claim(agent2)).json().jobs.map((j: any) => j.kind)).toEqual(['original']);
  });

  it('sem PC escolhido, qualquer agente 1.6.0+ pode imprimir', async () => {
    await app.inject({ method: 'PUT', url: '/api/admin/labels/printer', headers: admin, payload: printerBody({ deviceId: null }) });
    await setVersion(deviceId, '1.6.0');
    await app.inject({ method: 'POST', url: '/api/admin/labels/printer/test', headers: admin, payload: {} });
    expect((await claim()).json().jobs).toHaveLength(1);
  });
});
