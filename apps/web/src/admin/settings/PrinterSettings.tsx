import { useCallback, useEffect, useState } from 'react';
import { api, formatDateTime } from '../../lib/api';
import { useLiveEvents } from '../live';
import { PRINT, type PrintStatus } from '../labels';
import { canManage, useSession } from '../session';
import { Confirm, Modal, Toggle, errorText, useToast } from '../ui';
import { useSettings } from './useSettings';

interface Device {
  id: string; name: string; token_prefix: string; created_at: string; revoked_at: string | null; last_seen_at: string | null; last_ip: string | null;
  agent_version: string | null; printer_state: { mode?: string; target?: string; online?: boolean | null; paperOut?: boolean | null; coverOpen?: boolean | null; error?: string | null; localQueue?: number; checkedAt?: string };
  last_error: string | null; last_error_at: string | null; online: boolean;
}
interface QueueJob { id: string; kind: string; reprint_number: number; status: PrintStatus; attempts: number; max_attempts: number; last_error: string | null; created_at: string; order_number: number | null }

export function PrinterSettings() {
  const { user } = useSession();
  const manage = canManage(user);
  const toast = useToast();
  const { data, reload } = useSettings();
  const [status, setStatus] = useState<{ devices: Device[]; queue: QueueJob[] } | null>(null);
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [revoke, setRevoke] = useState<Device | null>(null);

  const loadStatus = useCallback(() => api<{ devices: Device[]; queue: QueueJob[] }>('/api/admin/printer/status').then(setStatus).catch(() => {}), []);
  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 15_000);
    return () => clearInterval(t);
  }, [loadStatus]);
  useLiveEvents((type) => (type.startsWith('print') || type === 'agent.updated') && loadStatus(), loadStatus);

  async function testPrint() {
    try {
      await api('/api/admin/printer/test', { method: 'POST', body: {} });
      toast('Impressão de teste enviada para a fila');
      loadStatus();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  const activeDevices = status?.devices.filter((d) => !d.revoked_at) ?? [];
  const anyOnline = activeDevices.some((d) => d.online);

  return (
    <div>
      <h2>Impressora</h2>
      <div className={`alert ${anyOnline ? 'alert-ok' : 'alert-warning'}`}>
        {anyOnline ? 'Agente de impressão conectado.' : activeDevices.length ? 'Nenhum agente conectado agora. Os pedidos ficam guardados na fila e imprimem quando o agente voltar.' : 'Nenhum agente instalado ainda. Crie uma credencial abaixo e instale o agente no computador da impressora.'}
      </div>

      <section className="card">
        <div className="a-section-head">
          <h3>Agentes instalados</h3>
          <div className="a-row">
            <button className="btn btn-secondary btn-sm" onClick={testPrint}>Imprimir teste</button>
            {manage && <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>+ Credencial de agente</button>}
          </div>
        </div>
        {status?.devices.length === 0 && <p className="muted small">Nenhuma credencial criada.</p>}
        <ul className="a-devices">
          {status?.devices.map((d) => {
            const ps = d.printer_state ?? {};
            return (
              <li key={d.id} className={d.revoked_at ? 'inactive' : ''}>
                <div className="ai-line">
                  <strong>{d.name}</strong>
                  <span className={`pill pill-sm ${d.revoked_at ? 'p-wait' : d.online ? 'p-ok' : 'p-fail'}`}>{d.revoked_at ? 'Revogado' : d.online ? 'Conectado' : 'Desconectado'}</span>
                </div>
                <div className="muted small">
                  Credencial {d.token_prefix}… · criada em {formatDateTime(d.created_at)}
                  {d.agent_version ? ` · versão ${d.agent_version}` : ''}
                  {d.last_seen_at ? ` · último contato ${formatDateTime(d.last_seen_at)}` : ' · nunca conectou'}
                </div>
                {ps.mode && (
                  <div className="small">
                    Impressora: {ps.target || ps.mode} · {ps.online === true ? 'respondendo' : ps.online === false ? 'sem resposta' : 'estado não informado pelo driver'}
                    {ps.paperOut ? ' · SEM PAPEL' : ''}{ps.coverOpen ? ' · TAMPA ABERTA' : ''}
                    {typeof ps.localQueue === 'number' && ps.localQueue > 0 ? ` · ${ps.localQueue} na fila local` : ''}
                  </div>
                )}
                {d.last_error && <div className="field-error">Último erro ({d.last_error_at ? formatDateTime(d.last_error_at) : ''}): {d.last_error}</div>}
                {manage && !d.revoked_at && <button className="btn btn-ghost btn-sm" onClick={() => setRevoke(d)}>Revogar credencial</button>}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="card">
        <h3>Fila de impressão (últimas 12 h e pendências)</h3>
        {!status?.queue.length && <p className="muted small">Fila vazia.</p>}
        <table className="a-table">
          <thead><tr><th>Trabalho</th><th>Criado</th><th>Situação</th><th>Tentativas</th></tr></thead>
          <tbody>
            {status?.queue.map((j) => (
              <tr key={j.id}>
                <td>{j.kind === 'test' ? 'Teste' : `#${j.order_number}${j.kind === 'reprint' ? ` (reimpressão ${j.reprint_number})` : ''}`}</td>
                <td>{formatDateTime(j.created_at)}</td>
                <td><span className={`pill pill-sm ${PRINT[j.status].cls}`}>{PRINT[j.status].label}</span>{j.last_error && j.status !== 'printed' && <div className="field-error small">{j.last_error}</div>}</td>
                <td>{j.attempts}/{j.max_attempts}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">Falhas e resultados incertos de pedidos são resolvidos no próprio pedido, na aba Pedidos.</p>
      </section>

      {data && <PrinterForm s={data.settings} manage={manage} onSaved={reload} />}

      <section className="card">
        <h3>Como funciona</h3>
        <ul className="small">
          <li>O agente fica instalado no computador ligado à Epson e busca os trabalhos no servidor pela internet. Não é preciso abrir portas no roteador.</li>
          <li>"Enviado à impressora" quer dizer que o Windows aceitou a comanda. Pela USB, a impressora não confirma a saída do papel; quando há confirmação (impressora de rede com status), aparece "Impresso".</li>
          <li>Se a internet cair, os pedidos continuam salvos na nuvem e imprimem quando o agente reconectar.</li>
          <li>Com o agente no modo padrão ("auto"), a conexão, o IP ou o nome da impressora no Windows e a largura do papel definidos aqui são aplicados no agente em até 30 segundos, sem mexer no computador da loja.</li>
        </ul>
      </section>

      {creating && <CreateDevice onClose={() => setCreating(false)} onCreated={(name, token) => { setCreating(false); setNewToken({ name, token }); loadStatus(); }} />}
      {newToken && (
        <Modal title="Credencial criada" onClose={() => setNewToken(null)} footer={<button className="btn btn-primary btn-block" onClick={() => setNewToken(null)}>Já copiei</button>}>
          <p className="alert alert-warning">Copie agora. Esta chave não será mostrada de novo. Se perder, revogue e crie outra.</p>
          <p>Agente: <strong>{newToken.name}</strong></p>
          <label className="field"><span>Chave do agente</span><textarea readOnly rows={3} value={newToken.token} onFocus={(e) => e.target.select()} /></label>
          <button className="btn btn-secondary btn-sm" onClick={() => navigator.clipboard?.writeText(newToken.token).then(() => toast('Chave copiada'))}>Copiar chave</button>
          <p className="muted small">Cole esta chave no instalador do agente (campo "Chave do agente") ou em <code>deviceToken</code> no arquivo <code>config.json</code>.</p>
        </Modal>
      )}
      {revoke && (
        <Confirm title={`Revogar "${revoke.name}"?`} text="O agente para de receber pedidos imediatamente. Trabalhos que estavam com ele voltam para a fila ou ficam como incertos." confirmLabel="Revogar" danger
          onClose={() => setRevoke(null)} onConfirm={async () => { await api(`/api/admin/printer/devices/${revoke.id}/revoke`, { method: 'POST', body: {} }); toast('Credencial revogada'); loadStatus(); }} />
      )}
    </div>
  );
}

function CreateDevice({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string, token: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState('Computador do caixa');
  return (
    <Modal title="Nova credencial de agente" onClose={onClose} footer={
      <button className="btn btn-primary btn-block" disabled={!name.trim()} onClick={async () => {
        try { const r = await api<{ token: string }>('/api/admin/printer/devices', { body: { name } }); onCreated(name, r.token); } catch (e) { toast(errorText(e), 'error'); }
      }}>Criar</button>
    }>
      <label className="field"><span>Nome para identificar o computador</span><input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoFocus /></label>
    </Modal>
  );
}

function PrinterForm({ s, manage, onSaved }: { s: Record<string, any>; manage: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    printerModel: s.printerModel, printerConnection: s.printerConnection, printerHost: s.printerHost, printerPort: String(s.printerPort),
    printerWindowsName: s.printerWindowsName, autoPrint: s.autoPrint, printCopies: String(s.printCopies), paperColumns: String(s.paperColumns), receiptFooter: s.receiptFooter,
  });
  async function save() {
    try {
      await api('/api/admin/settings/printer', { method: 'PUT', body: { ...f, printerPort: Number(f.printerPort), printCopies: Number(f.printCopies), paperColumns: Number(f.paperColumns) } });
      toast('Configuração da impressora salva');
      onSaved();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }
  return (
    <section className="card">
      <h3>Configuração da comanda e da impressora</h3>
      <fieldset disabled={!manage} className="plain">
        <Toggle checked={f.autoPrint} onChange={(v) => setF({ ...f, autoPrint: v })} label="Imprimir automaticamente cada pedido novo" />
        <div className="grid-2">
          <label className="field"><span>Modelo (confirme a etiqueta da impressora)</span>
            <select value={f.printerModel} onChange={(e) => setF({ ...f, printerModel: e.target.value })}>
              {['Epson TM-T20 (variante a confirmar)', 'Epson TM-T20', 'Epson TM-T20II', 'Epson TM-T20III', 'Epson TM-T20IIIL', 'Epson TM-T20X'].map((m) => <option key={m}>{m}</option>)}
            </select>
          </label>
          <label className="field"><span>Conexão</span>
            <select value={f.printerConnection} onChange={(e) => setF({ ...f, printerConnection: e.target.value })}>
              <option value="usb">USB (pelo driver do Windows)</option>
              <option value="network">Rede (Ethernet, IP)</option>
              <option value="serial">Serial (pelo driver/porta virtual do Windows)</option>
            </select>
          </label>
        </div>
        {f.printerConnection === 'network' ? (
          <div className="grid-2">
            <label className="field"><span>IP da impressora</span><input value={f.printerHost} onChange={(e) => setF({ ...f, printerHost: e.target.value })} placeholder="192.168.0.50" inputMode="decimal" /></label>
            <label className="field"><span>Porta</span><input inputMode="numeric" value={f.printerPort} onChange={(e) => setF({ ...f, printerPort: e.target.value.replace(/\D/g, '') })} /></label>
          </div>
        ) : (
          <label className="field"><span>Nome da impressora no Windows</span><input value={f.printerWindowsName} onChange={(e) => setF({ ...f, printerWindowsName: e.target.value })} placeholder="EPSON TM-T20 Receipt" /></label>
        )}
        <div className="grid-3">
          <label className="field"><span>Vias por pedido</span>
            <select value={f.printCopies} onChange={(e) => setF({ ...f, printCopies: e.target.value })}>{[1, 2, 3].map((n) => <option key={n}>{n}</option>)}</select>
          </label>
          <label className="field"><span>Largura do papel</span>
            <select value={f.paperColumns} onChange={(e) => setF({ ...f, paperColumns: e.target.value })}>
              <option value="48">80 mm (48 colunas)</option>
              <option value="42">80 mm, fonte maior (42 colunas)</option>
              <option value="32">58 mm (32 colunas)</option>
            </select>
          </label>
          <label className="field"><span>Rodapé da comanda</span><input value={f.receiptFooter} maxLength={200} onChange={(e) => setF({ ...f, receiptFooter: e.target.value })} /></label>
        </div>
        <p className="muted small">O agente usa estes dados para achar a impressora (modo "auto", o padrão). Só se alguém fixou outra impressora no config.json do computador da loja é que ela prevalece.</p>
        {manage && <button className="btn btn-primary" onClick={save}>Salvar</button>}
      </fieldset>
    </section>
  );
}
