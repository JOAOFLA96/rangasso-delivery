// Página do Monitor de Impressão (HTML, CSS e JS num arquivo só, servido pelo próprio agente).
declare const __LOGO_DATAURL__: string | undefined;
const LOGO = typeof __LOGO_DATAURL__ === 'string' ? __LOGO_DATAURL__ : '';

export const MONITOR_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Monitor de Impressão · Rangasso</title>
${LOGO ? `<link rel="icon" href="${LOGO}">` : ''}
<style>
  :root { --bg:#f4f2ef; --card:#fff; --ink:#151515; --muted:#6b6763; --line:#e6e2dd; --brand:#F05A2C; --brand-d:#c4410f;
          --ok:#1f8a4c; --ok-bg:#e5f5ec; --warn:#a15c00; --warn-bg:#fff2dc; --bad:#c0261c; --bad-bg:#fde8e6; --info:#2453a6; --info-bg:#e6eefb; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.45 "Segoe UI", system-ui, -apple-system, Roboto, sans-serif; }
  header { background:#fff; border-bottom:3px solid var(--brand); }
  .bar { max-width:1080px; margin:0 auto; padding:14px 20px; display:flex; align-items:center; gap:16px; }
  .bar img { height:38px; }
  .bar h1 { font-size:18px; margin:0; font-weight:700; letter-spacing:.2px; }
  .bar .sub { color:var(--muted); font-size:13px; }
  .bar .right { margin-left:auto; display:flex; gap:8px; align-items:center; }
  main { max-width:1080px; margin:0 auto; padding:20px; display:grid; gap:16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px 20px; }
  .card h2 { font-size:13px; text-transform:uppercase; letter-spacing:.8px; color:var(--muted); margin:0 0 12px; }
  .tiles { display:grid; grid-template-columns:repeat(3, 1fr); gap:16px; }
  .tile { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px 20px; position:relative; overflow:hidden; }
  .tile::before { content:""; position:absolute; left:0; top:0; bottom:0; width:5px; background:var(--line); }
  .tile.ok::before { background:var(--ok); } .tile.warn::before { background:#e69a1c; } .tile.bad::before { background:var(--bad); }
  .tile .label { font-size:12px; text-transform:uppercase; letter-spacing:.8px; color:var(--muted); }
  .tile .value { font-size:22px; font-weight:700; margin:6px 0 4px; display:flex; align-items:center; gap:10px; }
  .tile .detail { color:var(--muted); font-size:13px; word-break:break-word; }
  .dot { width:12px; height:12px; border-radius:50%; background:var(--line); flex:none; }
  .ok .dot { background:var(--ok); box-shadow:0 0 0 4px var(--ok-bg); } .warn .dot { background:#e69a1c; box-shadow:0 0 0 4px var(--warn-bg); }
  .bad .dot { background:var(--bad); box-shadow:0 0 0 4px var(--bad-bg); }
  .actions { display:flex; gap:10px; flex-wrap:wrap; }
  button { font:inherit; border-radius:10px; padding:10px 16px; border:1px solid var(--line); background:#fff; color:var(--ink); cursor:pointer; font-weight:600; }
  button:hover { border-color:#cfc9c2; }
  button.primary { background:var(--brand-d); border-color:var(--brand-d); color:#fff; }
  button.primary:hover { background:#a8380d; }
  button:disabled { opacity:.55; cursor:default; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:9px 6px; border-bottom:1px solid var(--line); font-size:14px; }
  th { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.6px; font-weight:600; }
  .pill { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:700; }
  .p-ok { background:var(--ok-bg); color:var(--ok); } .p-warn { background:var(--warn-bg); color:var(--warn); }
  .p-bad { background:var(--bad-bg); color:var(--bad); } .p-info { background:var(--info-bg); color:var(--info); }
  .empty { color:var(--muted); padding:8px 0; }
  form { display:grid; gap:14px; }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  label { display:grid; gap:6px; font-weight:600; font-size:14px; }
  label small { font-weight:400; color:var(--muted); }
  input, select { font:inherit; padding:10px 12px; border:1px solid #d8d2cb; border-radius:10px; background:#fff; width:100%; }
  input:focus, select:focus { outline:2px solid var(--brand); outline-offset:1px; border-color:transparent; }
  .modes { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }
  .mode { border:1px solid #d8d2cb; border-radius:12px; padding:12px; cursor:pointer; display:grid; gap:4px; font-weight:600; }
  .mode input { width:auto; margin:0 6px 0 0; }
  .mode span { font-weight:400; color:var(--muted); font-size:13px; }
  .mode.sel { border-color:var(--brand); box-shadow:0 0 0 1px var(--brand); background:#fff8f5; }
  .msg { padding:10px 14px; border-radius:10px; font-size:14px; }
  .msg.ok { background:var(--ok-bg); color:var(--ok); } .msg.bad { background:var(--bad-bg); color:var(--bad); } .msg.info { background:var(--info-bg); color:var(--info); }
  .welcome { border:2px solid var(--brand); }
  .welcome ol { margin:6px 0 0; padding-left:20px; color:var(--ink); }
  details summary { cursor:pointer; font-weight:600; }
  pre { background:#141414; color:#e9e6e2; border-radius:10px; padding:12px; max-height:320px; overflow:auto; font-size:12px; line-height:1.5; white-space:pre-wrap; word-break:break-word; }
  footer { max-width:1080px; margin:0 auto; padding:4px 20px 28px; color:var(--muted); font-size:12px; }
  .hidden { display:none !important; }
  @media (max-width:760px) { .tiles, .row, .modes { grid-template-columns:1fr; } .bar .sub { display:none; } }
</style>
</head>
<body>
<header><div class="bar">
  ${LOGO ? `<img src="${LOGO}" alt="Rangasso">` : '<strong>RANGASSO</strong>'}
  <div><h1>Monitor de Impressão</h1><div class="sub">Comandas do delivery na impressora do balcão</div></div>
  <div class="right"><span id="updated" class="sub"></span></div>
</div></header>

<main>
  <section id="welcome" class="card welcome hidden">
    <h2>Primeiro acesso</h2>
    <div style="font-size:17px;font-weight:700">Vamos ligar este computador ao sistema Rangasso</div>
    <ol>
      <li>No painel do sistema, abra <b>Configurações &gt; Impressora</b> e clique em <b>+ Credencial de agente</b>.</li>
      <li>Copie a chave (começa com <b>rgd_</b>) e cole abaixo, junto com o endereço do sistema.</li>
      <li>Clique em <b>Salvar e conectar</b> e depois em <b>Imprimir teste</b>.</li>
    </ol>
  </section>

  <section class="tiles">
    <div class="tile" id="t-conn"><div class="label">Sistema</div><div class="value"><span class="dot"></span><span>—</span></div><div class="detail"></div></div>
    <div class="tile" id="t-prn"><div class="label">Impressora</div><div class="value"><span class="dot"></span><span>—</span></div><div class="detail"></div></div>
    <div class="tile" id="t-queue"><div class="label">Hoje neste computador</div><div class="value"><span class="dot"></span><span>—</span></div><div class="detail"></div></div>
  </section>

  <section class="card">
    <div class="actions">
      <button class="primary" id="btn-test">Imprimir teste</button>
      <button id="btn-refresh">Verificar impressora agora</button>
      <button id="btn-open" class="hidden">Abrir o painel do sistema</button>
    </div>
    <div id="action-msg" class="msg hidden" style="margin-top:12px"></div>
  </section>

  <section class="card">
    <h2>Últimas comandas</h2>
    <table><thead><tr><th>Comanda</th><th>Resultado</th><th>Horário</th></tr></thead><tbody id="recent"></tbody></table>
    <div id="recent-empty" class="empty hidden">Nenhuma comanda impressa por este computador ainda.</div>
  </section>

  <section class="card" id="setup-card">
    <h2>Configuração</h2>
    <form id="setup">
      <div class="row">
        <label>Endereço do sistema<small>Ex.: https://rangasso.up.railway.app</small><input name="serverUrl" placeholder="https://" autocomplete="off" required></label>
        <label>Chave do agente<small id="token-hint">Começa com rgd_ (Painel &gt; Configurações &gt; Impressora)</small><input name="deviceToken" type="password" placeholder="rgd_..." autocomplete="off"></label>
      </div>
      <div>
        <div style="font-weight:600;font-size:14px;margin-bottom:8px">Qual impressora usar</div>
        <div class="modes">
          <label class="mode"><div><input type="radio" name="mode" value="auto" checked>A definida no painel</div><span>Recomendado. Você muda pelo painel, sem mexer aqui.</span></label>
          <label class="mode"><div><input type="radio" name="mode" value="windows">Impressora USB deste PC</div><span>Escolha na lista do Windows.</span></label>
          <label class="mode"><div><input type="radio" name="mode" value="network">Impressora de rede</div><span>Epson com cabo de rede (IP).</span></label>
        </div>
      </div>
      <label id="f-windows" class="hidden">Impressora do Windows<select name="windowsName"></select></label>
      <div id="f-network" class="row hidden">
        <label>IP da impressora<input name="host" placeholder="192.168.0.50"></label>
        <label>Porta<input name="port" type="number" value="9100" min="1" max="65535"></label>
      </div>
      <div class="actions"><button class="primary" type="submit" id="btn-save">Salvar e conectar</button></div>
      <div id="setup-msg" class="msg hidden"></div>
    </form>
  </section>

  <section class="card">
    <details><summary>Registro de atividade (para suporte)</summary><pre id="log"></pre></details>
  </section>
</main>
<footer>Agente Rangasso <span id="ver"></span> · Este monitor só abre neste computador. O agente continua funcionando com esta janela fechada.</footer>

<script>
const $ = (s) => document.querySelector(s);
const H = { 'content-type': 'application/json', 'x-rangasso-monitor': '1' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const time = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '';
const ago = (iso) => { if (!iso) return ''; const s = Math.round((Date.now() - Date.parse(iso)) / 1000); return s < 60 ? 'há ' + s + ' s' : 'há ' + Math.round(s/60) + ' min'; };
let formTouched = false, printersLoaded = false, last = null;

function tile(id, cls, value, detail) {
  const el = $(id); el.className = 'tile ' + cls;
  el.querySelector('.value span:last-child').textContent = value;
  el.querySelector('.detail').textContent = detail || '';
}
function msg(id, cls, text) { const el = $(id); el.className = 'msg ' + cls; el.textContent = text; if (!text) el.classList.add('hidden'); }

const OUT = { printed: ['Impresso', 'p-ok'], sent: ['Enviado à impressora', 'p-ok'], failed: ['Falhou (vai tentar de novo)', 'p-bad'], uncertain: ['Incerto: confira no balcão', 'p-warn'], sending: ['Imprimindo…', 'p-info'] };

function render(s) {
  last = s;
  $('#ver').textContent = s.version;
  $('#updated').textContent = 'Atualizado ' + new Date(s.now).toLocaleTimeString('pt-BR');
  $('#welcome').classList.toggle('hidden', s.configured);
  $('#btn-open').classList.toggle('hidden', !s.config);
  const a = s.agent;
  // Sistema
  if (!s.configured) tile('#t-conn', 'warn', 'Não configurado', s.configError || 'Preencha a configuração abaixo.');
  else if (!a || a.connection.ok === null) tile('#t-conn', '', 'Conectando…', s.config.serverUrl);
  else if (a.connection.ok) tile('#t-conn', 'ok', 'Conectado', (a.connection.deviceName ? a.connection.deviceName + ' · ' : '') + 'contato ' + ago(a.connection.lastOkAt));
  else tile('#t-conn', 'bad', 'Sem conexão', a.connection.lastError || '');
  // Impressora
  if (!a) tile('#t-prn', '', '—', 'Aguardando configuração.');
  else if (!a.printer) tile('#t-prn', 'warn', 'Não definida', a.printerError || '');
  else {
    const st = a.printerStatus || {};
    const where = a.printer.target + ' · ' + a.columns + ' colunas';
    if (st.paperOut) tile('#t-prn', 'bad', 'Sem papel', where);
    else if (st.coverOpen) tile('#t-prn', 'bad', 'Tampa aberta', where);
    else if (st.online === false) tile('#t-prn', 'bad', 'Desligada ou desconectada', (st.error ? st.error + ' · ' : '') + where);
    else if (st.online === true) tile('#t-prn', 'ok', 'Pronta', where);
    else tile('#t-prn', 'ok', 'Instalada', where + ' · pela USB a Epson não informa papel/tampa');
  }
  // Fila
  if (!a) tile('#t-queue', '', '—', '');
  else {
    const today = new Date().toDateString();
    const n = a.recent.filter((r) => new Date(r.at).toDateString() === today && (r.outcome === 'printed' || r.outcome === 'sent')).length;
    const problems = a.recent.filter((r) => r.outcome === 'failed' || r.outcome === 'uncertain').length;
    tile('#t-queue', a.pending ? 'warn' : problems ? 'warn' : 'ok', n + (n === 1 ? ' comanda' : ' comandas'),
      a.pending ? a.pending + ' aviso(s) aguardando internet para chegar ao sistema' : problems ? problems + ' com falha ou incerta nas últimas' : 'Tudo em dia');
  }
  // Últimas
  const rows = (a?.recent || []).map((r) => { const o = OUT[r.outcome || r.state] || [r.outcome || r.state, 'p-info'];
    return '<tr><td>' + esc(r.label) + '</td><td><span class="pill ' + o[1] + '">' + esc(o[0]) + '</span></td><td>' + esc(time(r.at)) + '</td></tr>'; });
  $('#recent').innerHTML = rows.join('');
  $('#recent-empty').classList.toggle('hidden', rows.length > 0);
  $('#btn-test').disabled = !a;
  // Log
  const pre = $('#log'); const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  pre.textContent = (s.log || []).join('\\n') || 'Sem registros ainda.';
  if (atBottom) pre.scrollTop = pre.scrollHeight;
  // Formulário (só preenche enquanto o usuário não mexeu)
  if (!formTouched) {
    const f = $('#setup');
    if (s.config) {
      f.serverUrl.value = s.config.serverUrl;
      $('#token-hint').textContent = s.config.hasToken ? 'Já cadastrada. Deixe em branco para manter.' : 'Começa com rgd_';
      f.querySelector('input[name=mode][value="' + (s.config.printer.mode === 'file' ? 'auto' : s.config.printer.mode) + '"]').checked = true;
      f.host.value = s.config.printer.host || ''; f.port.value = s.config.printer.port || 9100;
      f.dataset.windowsName = s.config.printer.windowsName || '';
    }
    syncModes();
  }
}

async function load(refresh) {
  try {
    const r = await fetch('/api/state' + (refresh ? '?refresh=1' : ''), { cache: 'no-store' });
    render(await r.json());
  } catch { $('#updated').textContent = 'Agente não responde. O serviço pode estar reiniciando…'; }
}

async function loadPrinters() {
  if (printersLoaded) return; printersLoaded = true;
  const sel = $('#setup').windowsName; sel.innerHTML = '<option>Carregando…</option>';
  const r = await (await fetch('/api/printers')).json();
  const want = $('#setup').dataset.windowsName;
  sel.innerHTML = r.printers.length ? r.printers.map((p) => '<option ' + ((want ? p.name === want : p.default) ? 'selected' : '') + ' value="' + esc(p.name) + '">' + esc(p.name) + (p.default ? ' (padrão)' : '') + '</option>').join('')
    : '<option value="">Nenhuma impressora encontrada no Windows</option>';
}

function syncModes() {
  const mode = $('#setup').querySelector('input[name=mode]:checked').value;
  document.querySelectorAll('.mode').forEach((m) => m.classList.toggle('sel', m.querySelector('input').checked));
  $('#f-windows').classList.toggle('hidden', mode !== 'windows');
  $('#f-network').classList.toggle('hidden', mode !== 'network');
  if (mode === 'windows') loadPrinters();
}

$('#setup').addEventListener('input', () => { formTouched = true; });
$('#setup').addEventListener('change', syncModes);
$('#setup').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target; const btn = $('#btn-save'); btn.disabled = true; msg('#setup-msg', 'info', 'Testando a conexão…');
  const body = { serverUrl: f.serverUrl.value, deviceToken: f.deviceToken.value,
    printer: { mode: f.querySelector('input[name=mode]:checked').value, windowsName: f.windowsName.value, host: f.host.value, port: Number(f.port.value) } };
  try {
    const r = await fetch('/api/setup', { method: 'POST', headers: H, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    f.deviceToken.value = ''; formTouched = false;
    msg('#setup-msg', 'ok', 'Configuração salva. O agente está reconectando; em alguns segundos o status acima fica verde.');
    setTimeout(() => load(true), 1500);
  } catch (e) { msg('#setup-msg', 'bad', e.message); }
  btn.disabled = false;
});
$('#btn-test').addEventListener('click', async () => {
  const b = $('#btn-test'); b.disabled = true; msg('#action-msg', 'info', 'Enviando comanda de teste…');
  try {
    const r = await fetch('/api/test-print', { method: 'POST', headers: H, body: '{}' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    msg('#action-msg', 'ok', (j.outcome === 'printed' ? 'Impresso (a impressora confirmou). ' : 'Enviado à impressora. ') + 'Confira se o papel saiu com acentos corretos e cortado.');
  } catch (e) { msg('#action-msg', 'bad', 'Não imprimiu: ' + e.message); }
  b.disabled = false; load(true);
});
$('#btn-refresh').addEventListener('click', () => load(true));
$('#btn-open').addEventListener('click', () => { if (last?.config) window.open(last.config.serverUrl + '/admin', '_blank', 'noopener'); });
load(false); setInterval(() => load(false), 3000);
</script>
</body>
</html>`;
