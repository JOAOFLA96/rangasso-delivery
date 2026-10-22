import { useEffect, useState } from 'react';
import { api, brl } from '../../lib/api';
import { canManage, useSession } from '../session';
import { Modal, Toggle, errorText, useToast } from '../ui';
import { centsToInput, inputToCents, useSettings, type SettingsData } from './useSettings';

const DAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

export function DeliverySettings() {
  const { data, error, reload } = useSettings();
  if (error) return <div className="alert alert-error">{error}</div>;
  if (!data) return <p className="muted">Carregando…</p>;
  return (
    <div>
      <h2>Entrega e horários</h2>
      <OpenStatus data={data} />
      <DeliveryRules data={data} reload={reload} />
      <Neighborhoods data={data} reload={reload} />
      <Hours data={data} reload={reload} />
      <Closures data={data} reload={reload} />
    </div>
  );
}

function OpenStatus({ data }: { data: SettingsData }) {
  const st = data.openState;
  const why: Record<string, string> = {
    forced_open: 'aberta manualmente', forced_closed: 'fechada manualmente', closure: 'exceção cadastrada para hoje',
    schedule: 'pelo horário de funcionamento', no_schedule: 'nenhum horário cadastrado',
  };
  return (
    <div className={`alert ${st.open ? 'alert-ok' : 'alert-warning'}`}>
      <strong>Loja {st.open ? 'aberta' : 'fechada'} agora</strong> ({why[st.reason] ?? st.reason}){!st.open && st.nextOpening ? `. Próxima abertura: ${st.nextOpening}.` : '.'}
    </div>
  );
}

function DeliveryRules({ data, reload }: { data: SettingsData; reload: () => Promise<void> }) {
  const { user } = useSession();
  const toast = useToast();
  const s = data.settings;
  const [f, setF] = useState({ minOrder: centsToInput(s.minOrderCents), etaMin: String(s.etaMinMinutes), etaMax: String(s.etaMaxMinutes), openMode: s.openMode, acceptUnlisted: s.acceptUnlistedNeighborhoods !== false });
  async function save() {
    const minOrderCents = inputToCents(f.minOrder) ?? 0;
    if (Number.isNaN(minOrderCents)) return toast('Pedido mínimo inválido.', 'error');
    try {
      await api('/api/admin/settings/delivery', { method: 'PUT', body: { minOrderCents, etaMinMinutes: Number(f.etaMin), etaMaxMinutes: Number(f.etaMax), openMode: f.openMode, acceptUnlistedNeighborhoods: f.acceptUnlisted } });
      toast('Regras de entrega salvas');
      reload();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }
  const disabled = !canManage(user);
  return (
    <section className="card">
      <h3>Regras gerais</h3>
      <div className="grid-3">
        <label className="field"><span>Pedido mínimo (R$)</span><input inputMode="decimal" value={f.minOrder} disabled={disabled} onChange={(e) => setF({ ...f, minOrder: e.target.value })} /></label>
        <label className="field"><span>Tempo mínimo (min)</span><input inputMode="numeric" value={f.etaMin} disabled={disabled} onChange={(e) => setF({ ...f, etaMin: e.target.value.replace(/\D/g, '') })} /></label>
        <label className="field"><span>Tempo máximo (min)</span><input inputMode="numeric" value={f.etaMax} disabled={disabled} onChange={(e) => setF({ ...f, etaMax: e.target.value.replace(/\D/g, '') })} /></label>
      </div>
      <label className="field"><span>Funcionamento</span>
        <select value={f.openMode} disabled={disabled} onChange={(e) => setF({ ...f, openMode: e.target.value })}>
          <option value="auto">Automático, pelo horário cadastrado</option>
          <option value="force_closed">Fechar agora (pausar pedidos)</option>
          <option value="force_open">Abrir agora, ignorando o horário</option>
        </select>
      </label>
      <Toggle checked={f.acceptUnlisted} disabled={disabled} onChange={(v) => setF({ ...f, acceptUnlisted: v })} label="Aceitar pedidos de bairros fora da lista (o CEP preenche o bairro e a taxa fica a combinar)" />
      {!disabled && <button className="btn btn-primary" onClick={save}>Salvar regras</button>}
    </section>
  );
}

function Neighborhoods({ data, reload }: { data: SettingsData; reload: () => Promise<void> }) {
  const { user } = useSession();
  const [edit, setEdit] = useState<Partial<SettingsData['neighborhoods'][number]> | null>(null);
  return (
    <section className="card">
      <div className="a-section-head">
        <h3>Bairros atendidos e taxas</h3>
        {canManage(user) && <button className="btn btn-primary btn-sm" onClick={() => setEdit({ name: '', city: '', feeCents: 0, minOrderCents: null, active: true })}>+ Bairro</button>}
      </div>
      <p className="muted small">O CEP do cliente preenche o bairro sozinho. Bairro novo entra aqui marcado "taxa a definir": edite e coloque a taxa. Bairro desativado = região não atendida.</p>
      {data.neighborhoods.some((n) => n.feePending && n.active) && (
        <p className="alert alert-warning">Há bairros novos sem taxa definida. Os pedidos deles saem com a taxa "a combinar" até você editar o bairro.</p>
      )}
      {!data.neighborhoods.length && !data.settings.acceptUnlistedNeighborhoods && <p className="alert alert-warning">Nenhum bairro cadastrado: sem bairro, o cliente não consegue finalizar pedidos.</p>}
      <table className="a-table">
        <thead><tr><th>Bairro</th><th>Taxa</th><th>Mín. próprio</th><th>Situação</th><th /></tr></thead>
        <tbody>
          {data.neighborhoods.map((n) => (
            <tr key={n.id} className={n.active ? '' : 'inactive'}>
              <td>{n.name}{n.city ? <span className="muted small"> · {n.city}</span> : null}</td>
              <td>{n.feePending ? <span className="badge badge-warning">Taxa a definir</span> : brl(n.feeCents)}</td>
              <td>{n.minOrderCents != null ? brl(n.minOrderCents) : '—'}</td>
              <td>{n.active ? 'Atendido' : 'Não atendido'}</td>
              <td>{canManage(user) && <button className="btn btn-secondary btn-sm" onClick={() => setEdit(n)}>Editar</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && <NeighborhoodModal n={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </section>
  );
}

function NeighborhoodModal({ n, onClose, onSaved }: { n: Partial<SettingsData['neighborhoods'][number]>; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: n.name ?? '', city: n.city ?? '', fee: n.feePending ? '' : centsToInput(n.feeCents ?? 0), min: centsToInput(n.minOrderCents ?? null), active: n.active ?? true });
  async function save() {
    const feeCents = inputToCents(f.fee);
    const minOrderCents = inputToCents(f.min);
    if (feeCents == null || Number.isNaN(feeCents) || Number.isNaN(minOrderCents)) return toast('Valor inválido. Use o formato 7,50.', 'error');
    const body = { name: f.name.trim(), city: f.city.trim(), feeCents, minOrderCents, active: f.active };
    try {
      if (n.id) await api(`/api/admin/neighborhoods/${n.id}`, { method: 'PUT', body });
      else await api('/api/admin/neighborhoods', { body });
      toast('Bairro salvo');
      onSaved();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }
  return (
    <Modal title={n.id ? 'Editar bairro' : 'Novo bairro'} onClose={onClose} footer={<button className="btn btn-primary btn-block" onClick={save} disabled={!f.name.trim()}>Salvar</button>}>
      <label className="field"><span>Nome do bairro</span><input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></label>
      <label className="field"><span>Cidade (opcional)</span><input value={f.city} maxLength={80} onChange={(e) => setF({ ...f, city: e.target.value })} /></label>
      <div className="grid-2">
        <label className="field"><span>Taxa de entrega (R$)</span><input inputMode="decimal" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} /></label>
        <label className="field"><span>Pedido mínimo do bairro (opcional)</span><input inputMode="decimal" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} placeholder="usa o geral" /></label>
      </div>
      <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Atendemos este bairro" />
    </Modal>
  );
}

function Hours({ data, reload }: { data: SettingsData; reload: () => Promise<void> }) {
  const { user } = useSession();
  const toast = useToast();
  const [shifts, setShifts] = useState(data.hours);
  useEffect(() => setShifts(data.hours), [data.hours]);
  const manage = canManage(user);
  async function save() {
    try {
      await api('/api/admin/settings/hours', { method: 'PUT', body: { shifts } });
      toast('Horários salvos');
      reload();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }
  return (
    <section className="card">
      <h3>Horário de funcionamento</h3>
      <p className="muted small">Fora destes horários o cardápio mostra "fechado" e não aceita pedidos. Se o fechamento for depois da meia-noite (ex.: 18:00 às 02:00), cadastre no dia em que abre.</p>
      <div className="a-hours">
        {DAYS.map((day, wd) => {
          const list = shifts.map((s, i) => ({ ...s, i })).filter((s) => s.weekday === wd);
          return (
            <div key={wd} className="a-hours-day">
              <strong>{day}</strong>
              <div className="a-hours-shifts">
                {list.length === 0 && <span className="muted small">Fechado</span>}
                {list.map((s) => (
                  <div key={s.i} className="a-row">
                    <input type="time" value={s.opensAt} disabled={!manage} aria-label={`${day} abre`} onChange={(e) => setShifts(shifts.map((x, j) => (j === s.i ? { ...x, opensAt: e.target.value } : x)))} />
                    <span>às</span>
                    <input type="time" value={s.closesAt} disabled={!manage} aria-label={`${day} fecha`} onChange={(e) => setShifts(shifts.map((x, j) => (j === s.i ? { ...x, closesAt: e.target.value } : x)))} />
                    {manage && <button className="btn btn-ghost btn-sm" aria-label="Remover turno" onClick={() => setShifts(shifts.filter((_, j) => j !== s.i))}>✕</button>}
                  </div>
                ))}
                {manage && <button className="btn btn-link small" onClick={() => setShifts([...shifts, { weekday: wd, opensAt: '18:00', closesAt: '23:00' }])}>+ turno</button>}
              </div>
            </div>
          );
        })}
      </div>
      {manage && <button className="btn btn-primary" onClick={save}>Salvar horários</button>}
    </section>
  );
}

function Closures({ data, reload }: { data: SettingsData; reload: () => Promise<void> }) {
  const { user } = useSession();
  const toast = useToast();
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const manage = canManage(user);
  return (
    <section className="card">
      <h3>Exceções e dias fechados</h3>
      <p className="muted small">Feriados, folgas ou eventos: a loja fica fechada o dia inteiro na data cadastrada.</p>
      <ul className="a-simple-list">
        {data.closures.map((c) => (
          <li key={c.id}>
            <span>{new Date(c.date + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })}{c.reason ? ` · ${c.reason}` : ''}</span>
            {manage && <button className="btn btn-ghost btn-sm" onClick={async () => { await api(`/api/admin/closures/${c.id}`, { method: 'DELETE' }).catch((e) => toast(errorText(e), 'error')); reload(); }}>Remover</button>}
          </li>
        ))}
        {!data.closures.length && <li className="muted small">Nenhuma exceção futura.</li>}
      </ul>
      {manage && (
        <div className="a-row wrap">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Data" style={{ maxWidth: 180 }} />
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo (opcional)" maxLength={120} style={{ maxWidth: 260 }} />
          <button className="btn btn-secondary" disabled={!date} onClick={async () => {
            try { await api('/api/admin/closures', { body: { date, reason } }); setDate(''); setReason(''); toast('Exceção cadastrada'); reload(); } catch (e) { toast(errorText(e), 'error'); }
          }}>Adicionar</button>
        </div>
      )}
    </section>
  );
}
