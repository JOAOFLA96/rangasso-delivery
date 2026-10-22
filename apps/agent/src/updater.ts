import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Atualização automática do agente. O servidor Rangasso publica o agent.cjs da mesma versão do site
// (GET /api/agent/update). O agente baixa, confere o SHA-256 e grava em <dados>\update; o serviço reinicia
// e o agent.cjs instalado passa a carregar a versão nova. Se a versão nova não conseguir se conectar ao
// servidor depois de 3 partidas, ela é descartada e volta a valer a versão instalada.

export const MAX_ATTEMPTS = 3;

export interface UpdateState {
  version: string;
  file: string;
  sha256: string;
  attempts: number;
  healthy: boolean;
  bad: string[];
}

export function compareVersions(a: string, b: string) {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

const dirOf = (dataDir: string) => path.join(dataDir, 'update');
const stateFile = (dataDir: string) => path.join(dirOf(dataDir), 'state.json');
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

export function readState(dataDir: string): UpdateState | null {
  try {
    return JSON.parse(readFileSync(stateFile(dataDir), 'utf8')) as UpdateState;
  } catch {
    return null;
  }
}

function writeState(dataDir: string, s: UpdateState) {
  mkdirSync(dirOf(dataDir), { recursive: true });
  const tmp = stateFile(dataDir) + '.tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, stateFile(dataDir));
}

// Chamado pelo agent.cjs instalado ao iniciar o serviço: devolve o arquivo da versão nova a carregar, ou null.
export function pickUpdate(dataDir: string, installedVersion: string): string | null {
  const s = readState(dataDir);
  if (!s || !s.version || compareVersions(s.version, installedVersion) <= 0) return null;
  if (s.bad.includes(s.version)) return null;
  if (!s.healthy && s.attempts >= MAX_ATTEMPTS) {
    writeState(dataDir, { ...s, bad: [...s.bad, s.version] });
    return null;
  }
  const file = path.join(dirOf(dataDir), path.basename(s.file));
  try {
    if (sha256(readFileSync(file)) !== s.sha256) return null;
  } catch {
    return null;
  }
  if (!s.healthy) writeState(dataDir, { ...s, attempts: s.attempts + 1 });
  return file;
}

// A versão em execução conseguiu falar com o servidor: fica valendo.
export function markHealthy(dataDir: string, runningVersion: string) {
  const s = readState(dataDir);
  if (s && s.version === runningVersion && !s.healthy) writeState(dataDir, { ...s, healthy: true, attempts: 0 });
}

export interface UpdateSource {
  latest(): Promise<{ version: string | null; sha256?: string; size?: number }>;
  download(): Promise<Buffer>;
}

// Confere se o servidor tem versão mais nova; se tiver, baixa e deixa pronta. Devolve a versão baixada (ou null).
export async function downloadUpdate(src: UpdateSource, dataDir: string, runningVersion: string): Promise<string | null> {
  const info = await src.latest();
  if (!info.version || !info.sha256 || compareVersions(info.version, runningVersion) <= 0) return null;
  const s = readState(dataDir);
  if (s?.bad.includes(info.version)) return null;
  if (s && s.version === info.version && s.sha256 === info.sha256 && existsSync(path.join(dirOf(dataDir), path.basename(s.file)))) {
    return info.version; // já baixada, falta só reiniciar
  }
  const buf = await src.download();
  if (sha256(buf) !== info.sha256) throw new Error('arquivo da atualização veio diferente do esperado (SHA-256); ignorado');
  if (buf.length < 1000) throw new Error('arquivo da atualização inválido');
  mkdirSync(dirOf(dataDir), { recursive: true });
  const name = `agent-${info.version.replace(/[^0-9A-Za-z.-]/g, '')}.cjs`;
  const tmp = path.join(dirOf(dataDir), name + '.tmp');
  writeFileSync(tmp, buf);
  renameSync(tmp, path.join(dirOf(dataDir), name));
  writeState(dataDir, { version: info.version, file: name, sha256: info.sha256, attempts: 0, healthy: false, bad: s?.bad ?? [] });
  // Limpa versões antigas baixadas.
  for (const f of readdirSync(dirOf(dataDir))) {
    if (/^agent-.*\.cjs$/.test(f) && f !== name) rmSync(path.join(dirOf(dataDir), f), { force: true });
  }
  return info.version;
}
