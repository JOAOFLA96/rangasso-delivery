// Gera build/agent.cjs (arquivo único, sem node_modules) com a versão do package.json embutida.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
await build({
  entryPoints: [new URL('../src/cli.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: new URL('../build/agent.cjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  define: { __AGENT_VERSION__: JSON.stringify(version) },
  legalComments: 'none',
  logLevel: 'info',
});
