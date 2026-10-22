import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
