import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Agent } from '../src/agent.js';
import type { AgentApi, ServerJob } from '../src/api.js';
import { Logger } from '../src/logger.js';
import type { Printer } from '../src/printers/types.js';
import { plain, renderTspl, type TsplPayload } from '../src/tspl.js';

const settings = { printerName: 'OIA-B381', widthMm: 50, heightMm: 30, gapMm: 4, speed: 2, density: 12, offsetXmm: 0, offsetYmm: 0, rotate: false };
const payload = (over: Partial<TsplPayload> = {}): TsplPayload => ({
  store: { name: 'Rangasso', timezone: 'America/Sao_Paulo' },
  label: {
    productName: 'Coxinha de frango com catupiry 6 unidades', labelType: 'handled', storage: 'chilled',
    handledAt: '2026-11-05T21:44:00.000Z', expiresAt: '2026-11-07T21:44:00.000Z',
    responsible: 'João', lot: '261105-003', quantityText: '2 kg', extra: '', notes: 'Manter até 4 °C',
  },
  tspl: settings,
  ...over,
});

describe('etiqueta em TSPL', () => {
  it('define tamanho 50x30, espaço de 4 mm, velocidade, densidade e cópias', () => {
    const t = renderTspl(payload(), 3).toString('ascii');
    const lines = t.split('\r\n');
    expect(lines.slice(0, 5)).toEqual(['SIZE 50 mm,30 mm', 'GAP 4 mm,0 mm', 'SPEED 2', 'DENSITY 12', 'DIRECTION 1']);
    expect(lines).toContain('CLS');
    expect(lines.at(-2)).toBe('PRINT 1,3');
    expect(t.endsWith('\r\n')).toBe(true);
  });

  it('escreve os dados sem acento, com validade e dia da semana no fuso da loja, e nada passa da etiqueta', () => {
    const t = renderTspl(payload()).toString('ascii');
    expect(t).toContain('"COXINHA DE FRANGO COM"');
    expect(t).toContain('"CATUPIRY 6 UNIDADES"');
    expect(t).toContain('"MANIPULADO - RESFRIADO ATE 5C"');
    expect(t).toContain('MANIP: 05/11/26 18:44');
    expect(t).toContain('VAL: SAB 07/11/26 18:44');
    expect(t).toMatch(/RESP: Joao\s+LOTE 261105-003/);
    expect(t).toContain('2 kg - Manter ate 4 C - Rangasso');
    expect(/[^\x00-\x7f]/.test(t)).toBe(false);
    // Coordenadas dentro de 50x30 mm (400 x 240 pontos) e largura do texto dentro da etiqueta.
    for (const m of t.matchAll(/^TEXT (\d+),(\d+),"(\d)",0,1,1,"(.*)"$/gm)) {
      const [x, y, font, s] = [Number(m[1]), Number(m[2]), m[3], m[4]];
      const fw = { '1': 8, '2': 12, '3': 16 }[font]!;
      const fh = { '1': 12, '2': 20, '3': 24 }[font]!;
      expect(x + s.length * fw, s).toBeLessThanOrEqual(400);
      expect(y + fh, s).toBeLessThanOrEqual(240);
    }
  });

  it('respeita deslocamento, giro e limites; aspas do texto não quebram o comando', () => {
    const p = payload({ tspl: { ...settings, offsetXmm: 1, offsetYmm: -1, rotate: true, speed: 99, density: -3 } });
    p.label!.productName = 'Molho "da casa"';
    const t = renderTspl(p, 500).toString('ascii');
    expect(t).toContain('DIRECTION 0');
    expect(t).toContain('SPEED 6');
    expect(t).toContain('DENSITY 0');
    expect(t).toContain('PRINT 1,50');
    expect(t).toContain(`"MOLHO 'DA CASA'"`);
    expect(t).toMatch(/^TEXT 20,0,"3"/m); // x 12 + 8 pontos, y 8 - 8 pontos
    expect(plain('Ação "x" °C')).toBe("Acao 'x' C");
  });

  it('teste de calibração desenha moldura do tamanho da etiqueta', () => {
    const t = renderTspl({ store: { name: 'Rangasso' }, calibration: true, tspl: settings }, 3).toString('ascii');
    expect(t).toContain('BOX 4,4,396,236,3');
    expect(t).toContain('PRINT 1,3');
  });

  it('agente manda a etiqueta TSPL para a impressora de etiquetas indicada, não para a Epson', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rg-tspl-'));
    const sent: { name: string; data: Buffer }[] = [];
    const reports: string[] = [];
    let epsonUsed = false;
    const api = {
      jobs: async () => ({ jobs: queue.splice(0) }),
      report: async (_id: string, status: string) => { reports.push(status); return { ok: true }; },
      heartbeat: async () => ({ ok: true, serverTime: new Date().toISOString(), device: { name: 'Cozinha' }, printer: null }),
    };
    const queue: ServerJob[] = [{ id: 'l1', claimId: 'c1', kind: 'label', reprintNumber: 0, copies: 2, attempt: 1, payload: payload(), createdAt: new Date().toISOString() }];
    const agent = new Agent(
      { serverUrl: 'http://x', deviceToken: 'rgd_' + 'x'.repeat(30), printer: { mode: 'auto', windowsName: '', host: '', port: 9100, columns: 0, outputDir: '' }, dataDir: dir, logLevel: 'error', configPath: path.join(dir, 'c.json') },
      new Logger(dir, 'error', false),
      {
        api: api as unknown as AgentApi, longPollSeconds: 0, sleep: async () => {},
        printerFactory: () => { epsonUsed = true; throw new Error('não deveria usar a Epson'); },
        labelPrinterFactory: (name): Printer => ({
          mode: 'windows', target: name, status: async () => ({ online: true }),
          print: async (data) => { sent.push({ name, data }); return { outcome: 'sent', detail: 'ok' }; },
        }),
      },
    );
    await agent.handleJob(queue.shift()!);
    expect(epsonUsed).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0].name).toBe('OIA-B381');
    expect(sent[0].data.toString('ascii')).toContain('PRINT 1,2');
    expect(reports).toEqual(['sending', 'sent']);
  });
});
