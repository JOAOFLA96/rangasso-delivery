import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

// agent.cjs publicado junto com o servidor (a imagem Docker inclui o build do agente da mesma versão do site).
let cache: { mtimeMs: number; version: string; sha256: string; size: number; content: Buffer } | null = null;

export async function agentBundle() {
  const dir = path.resolve(config.AGENT_BUNDLE_DIR);
  try {
    const file = path.join(dir, 'agent.cjs');
    const st = await stat(file);
    if (cache && cache.mtimeMs === st.mtimeMs) return cache;
    const { version } = JSON.parse(await readFile(path.join(dir, 'agent-version.json'), 'utf8'));
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) return null;
    const content = await readFile(file);
    cache = { mtimeMs: st.mtimeMs, version, sha256: createHash('sha256').update(content).digest('hex'), size: content.length, content };
    return cache;
  } catch {
    return null;
  }
}
