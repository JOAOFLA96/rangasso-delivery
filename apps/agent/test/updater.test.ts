import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareVersions, downloadUpdate, markHealthy, MAX_ATTEMPTS, pickUpdate, readState } from '../src/updater.js';

const code = Buffer.from(`"use strict";\n${'// agente novo\n'.repeat(100)}`);
const sha = createHash('sha256').update(code).digest('hex');
const source = (version: string | null, body = code, hash = sha) => {
  let downloads = 0;
  return {
    get downloads() { return downloads; },
    latest: async () => ({ version, sha256: hash, size: body.length }),
    download: async () => { downloads++; return body; },
  };
};
const tmp = () => mkdtempSync(path.join(tmpdir(), 'rg-upd-'));

describe('atualização automática do agente', () => {
  it('compara versões', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.3.0', '1.3.0')).toBe(0);
    expect(compareVersions('1.2.9', '1.3.0')).toBe(-1);
  });

  it('não baixa quando o servidor não tem versão mais nova', async () => {
    const dir = tmp();
    const src = source('1.3.0');
    expect(await downloadUpdate(src, dir, '1.3.0')).toBeNull();
    expect(await downloadUpdate(source(null), dir, '1.3.0')).toBeNull();
    expect(src.downloads).toBe(0);
  });

  it('baixa, confere o SHA-256 e a versão instalada passa a carregar a nova', async () => {
    const dir = tmp();
    const src = source('1.4.0');
    expect(await downloadUpdate(src, dir, '1.3.0')).toBe('1.4.0');
    expect(await downloadUpdate(src, dir, '1.3.0')).toBe('1.4.0'); // já baixada: não baixa de novo
    expect(src.downloads).toBe(1);
    const file = pickUpdate(dir, '1.3.0');
    expect(file && path.basename(file)).toBe('agent-1.4.0.cjs');
    expect(readState(dir)).toMatchObject({ version: '1.4.0', attempts: 1, healthy: false });
    markHealthy(dir, '1.4.0');
    expect(readState(dir)).toMatchObject({ healthy: true, attempts: 0 });
    pickUpdate(dir, '1.3.0');
    expect(readState(dir)!.attempts).toBe(0); // versão confirmada não conta tentativas
    // Instalador mais novo que a atualização baixada: vale o instalado.
    expect(pickUpdate(dir, '1.5.0')).toBeNull();
  });

  it('arquivo diferente do anunciado é recusado', async () => {
    const dir = tmp();
    await expect(downloadUpdate(source('1.4.0', code, 'f'.repeat(64)), dir, '1.3.0')).rejects.toThrow(/SHA-256/);
    expect(readState(dir)).toBeNull();
    // Arquivo alterado no disco depois de baixado também não carrega.
    await downloadUpdate(source('1.4.0'), dir, '1.3.0');
    writeFileSync(path.join(dir, 'update', 'agent-1.4.0.cjs'), 'adulterado');
    expect(pickUpdate(dir, '1.3.0')).toBeNull();
  });

  it(`versão que não conecta em ${MAX_ATTEMPTS} partidas é descartada`, async () => {
    const dir = tmp();
    await downloadUpdate(source('1.4.0'), dir, '1.3.0');
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect(pickUpdate(dir, '1.3.0')).not.toBeNull();
    expect(pickUpdate(dir, '1.3.0')).toBeNull();
    expect(readState(dir)!.bad).toEqual(['1.4.0']);
    expect(await downloadUpdate(source('1.4.0'), dir, '1.3.0')).toBeNull(); // não baixa a mesma de novo
    expect(await downloadUpdate(source('1.4.1'), dir, '1.3.0')).toBe('1.4.1'); // a próxima correção sim
    expect(readdirSync(path.join(dir, 'update')).filter((f) => f.endsWith('.cjs'))).toEqual(['agent-1.4.1.cjs']);
  });
});
