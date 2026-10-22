// Servidor falso usado só no teste de fumaça do Windows: responde como o sistema Rangasso e oferece
// uma "versão nova" do agente (o próprio agent.cjs instalado com a versão trocada). Escuta em todas as
// interfaces: no Windows, "localhost" resolve primeiro para ::1 (IPv6).
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const [, , agentFile, oldVersion, newVersion, port] = process.argv;
const bundle = Buffer.from(fs.readFileSync(agentFile, 'utf8').split(JSON.stringify(oldVersion)).join(JSON.stringify(newVersion)));
const sha256 = crypto.createHash('sha256').update(bundle).digest('hex');
const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  console.log(new Date().toISOString(), req.method, url, req.headers['user-agent']);
  if (url === '/api/agent/heartbeat') {
    req.resume();
    return json(res, { ok: true, serverTime: new Date().toISOString(), device: { name: 'CI' }, printer: { connection: 'usb', host: '', port: 9100, windowsName: 'Rangasso Teste', columns: 48, model: 'CI' } });
  }
  if (url === '/api/agent/jobs') return setTimeout(() => json(res, { jobs: [] }), 1000);
  if (url === '/api/agent/update') return json(res, { version: newVersion, sha256, size: bundle.length });
  if (url === '/api/agent/update/agent.cjs') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(bundle); }
  res.writeHead(404); res.end('{}');
}).listen(Number(port), () => console.log(`servidor falso em ${port}, oferecendo ${newVersion}`));
