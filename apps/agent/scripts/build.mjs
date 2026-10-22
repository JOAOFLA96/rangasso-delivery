// Gera build/agent.cjs (arquivo único, sem node_modules) com a versão do package.json e o logo embutidos.
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// Logo do Monitor de Impressão embutido no próprio agent.cjs (a página não depende de arquivos externos).
const logo = 'data:image/png;base64,' + readFileSync(new URL('../assets/logo.png', import.meta.url)).toString('base64');
await build({
  entryPoints: [new URL('../src/cli.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: new URL('../build/agent.cjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  define: { __AGENT_VERSION__: JSON.stringify(version), __LOGO_DATAURL__: JSON.stringify(logo) },
  legalComments: 'none',
  logLevel: 'info',
});
// Versão ao lado do bundle: o servidor usa para oferecer a atualização automática aos agentes.
writeFileSync(new URL('../build/agent-version.json', import.meta.url), JSON.stringify({ version }) + '\n');
