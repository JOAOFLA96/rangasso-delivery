// Monta o pacote do agente para Windows x64 em dist/RangassoAgent-<versão>/ e o .zip correspondente.
// Baixa o Node.js portátil e o WinSW (gerenciador de serviço) e confere o SHA-256 de cada download.
// Uso: node scripts/package-win.mjs   (rode antes: npm run build)
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

// Versões fixadas. Para atualizar, troque a versão e o hash (Node: SHASUMS256.txt oficial; WinSW: hash do release).
const NODE = {
  version: '24.22.1',
  url: 'https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip',
  sha256: 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5',
};
const WINSW = {
  version: '2.12.0',
  url: 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe',
  sha256: '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da',
};

const cache = path.join(root, '.cache');
const outName = `RangassoAgent-${version}`;
const dist = path.join(root, 'dist');
const out = path.join(dist, outName);

async function download(item, file) {
  const dest = path.join(cache, file);
  if (!existsSync(dest)) {
    mkdirSync(cache, { recursive: true });
    console.log(`Baixando ${item.url}`);
    const res = await fetch(item.url);
    if (!res.ok) throw new Error(`Falha ao baixar ${item.url}: HTTP ${res.status}`);
    writeFileSync(dest + '.part', Buffer.from(await res.arrayBuffer()));
    renameSync(dest + '.part', dest);
  }
  const hash = createHash('sha256').update(readFileSync(dest)).digest('hex');
  if (hash !== item.sha256) {
    rmSync(dest);
    throw new Error(`SHA-256 não confere para ${file}: esperado ${item.sha256}, obtido ${hash}. Download descartado.`);
  }
  return dest;
}

function unzip(zip, dir) {
  mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') execFileSync('tar', ['-xf', zip, '-C', dir], { stdio: 'inherit' });
  else execFileSync('unzip', ['-q', '-o', zip, '-d', dir], { stdio: 'inherit' });
}

const bundle = path.join(root, 'build', 'agent.cjs');
if (!existsSync(bundle)) throw new Error('build/agent.cjs não existe. Rode "npm run build" antes.');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const nodeZip = await download(NODE, `node-v${NODE.version}-win-x64.zip`);
const tmp = path.join(cache, 'node-extract');
rmSync(tmp, { recursive: true, force: true });
unzip(nodeZip, tmp);
const nodeDir = path.join(tmp, `node-v${NODE.version}-win-x64`);
mkdirSync(path.join(out, 'node'));
cpSync(path.join(nodeDir, 'node.exe'), path.join(out, 'node', 'node.exe'));
cpSync(path.join(nodeDir, 'LICENSE'), path.join(out, 'node', 'LICENSE.txt'));

const winsw = await download(WINSW, `WinSW-x64-${WINSW.version}.exe`);
cpSync(winsw, path.join(out, 'RangassoAgent.exe'));

cpSync(bundle, path.join(out, 'agent.cjs'));
mkdirSync(path.join(out, 'scripts'));
for (const f of ['raw-print.ps1', 'printer-status.ps1']) cpSync(path.join(root, 'windows', f), path.join(out, 'scripts', f));
for (const f of ['RangassoAgent.xml', 'install.ps1', 'uninstall.ps1', 'rangasso-agent.cmd', 'LEIA-ME.txt']) {
  cpSync(path.join(root, 'windows', 'installer', f), path.join(out, f));
}
cpSync(path.join(root, 'config.example.json'), path.join(out, 'config.example.json'));
writeFileSync(path.join(out, 'VERSION.txt'), `Agente Rangasso ${version}\nNode.js ${NODE.version}\nWinSW ${WINSW.version}\n`);

const zipFile = path.join(dist, `${outName}-win-x64.zip`);
rmSync(zipFile, { force: true });
if (process.platform === 'win32') {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${out}' -DestinationPath '${zipFile}'`], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-q', '-r', zipFile, outName], { cwd: dist, stdio: 'inherit' });
}
console.log(`Pacote: ${out}\nZip:    ${zipFile}`);
