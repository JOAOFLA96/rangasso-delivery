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
      <DistanceFee data={data} reload={reload} />
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

const kmText = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const parseNum = (v: string) => Number(v.trim().replace(',', '.'));

function DistanceFee({ data, reload }: { data: SettingsData; reload: () => Promise<void> }) {
  const { user } = useSession();
  const toast = useToast();
  const d = data.distance;
  const manage = canManage(user);
  const [mode, setMode] = useState(d.mode);
  const [address, setAddress] = useState<string>(data.settings.address ?? '');
  const [lat, setLat] = useState(d.storeLat == null ? '' : String(d.storeLat));
  const [lng, setLng] = useState(d.storeLng == null ? '' : String(d.storeLng));
  const [found, setFound] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [tiers, setTiers] = useState(d.tiers.length ? d.tiers.map((t) => ({ km: kmText(t.maxKm), fee: centsToInput(t.feeCents) })) : [{ km: '2', fee: '' }, { km: '4', fee: '' }, { km: '6', fee: '' }]);

  async function locate() {
    setLocating(true);
    try {
      const r = await api<{ lat: number; lng: number; precision: string; label: string }>('/api/admin/settings/locate-store', { body: { address } });
      setLat(String(r.lat));
      setLng(String(r.lng));
      setFound(`${r.label}${r.precision === 'cep' ? ' (achado só pelo CEP: confira no mapa)' : ''}`);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setLocating(false);
    }
  }

  async function save() {
    const storeLat = lat.trim() ? parseNum(lat) : null;
    const storeLng = lng.trim() ? parseNum(lng) : null;
    if (Number.isNaN(storeLat) || Number.isNaN(storeLng)) return toast('Latitude/longitude inválida. Ex.: -23.0896', 'error');
    const parsed = tiers.filter((t) => t.km.trim() || t.fee.trim()).map((t) => ({ maxKm: parseNum(t.km), feeCents: inputToCents(t.fee) }));
    if (parsed.some((t) => !(t.maxKm > 0) || t.feeCents == null || Number.isNaN(t.feeCents))) return toast('Confira as faixas: km maior que zero e taxa no formato 7,50.', 'error');
    try {
      await api('/api/admin/settings/distance', { method: 'PUT', body: { mode, storeLat, storeLng, tiers: parsed, ...(address.trim() ? { address: address.trim() } : {}) } });
      toast('Taxa por km salva');
      reload();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  const sorted = tiers.map((t, i) => ({ ...t, i, n: parseNum(t.km) })).filter((t) => t.n > 0).sort((a, b) => a.n - b.n);
  const hasPoint = lat.trim() && lng.trim();
  return (
    <section className="card">
      <h3>Como cobrar a entrega</h3>
      <div className="radio-list">
        <label className={`radio-card ${mode === 'neighborhood' ? 'checked' : ''}`}>
          <input type="radio" name="fee-mode" checked={mode === 'neighborhood'} disabled={!manage} onChange={() => setMode('neighborhood')} />
          <span>Por bairro (taxa de cada bairro, abaixo)</span>
        </label>
        <label className={`radio-card ${mode === 'distance' ? 'checked' : ''}`}>
          <input type="radio" name="fee-mode" checked={mode === 'distance'} disabled={!manage} onChange={() => setMode('distance')} />
          <span>Por distância (km da loja até o cliente)</span>
        </label>
      </div>
      {mode === 'distance' && (
        <>
          <p className="muted small">
            O sistema acha o endereço do cliente no mapa (OpenStreetMap ou, se não achar, pelo CEP) e mede a distância em linha reta até a loja. Pelas ruas, o caminho
            costuma ser 20% a 40% maior: leve isso em conta nas faixas. Se o endereço não for encontrado, vale a taxa do bairro.
          </p>
          <label className="field"><span>Endereço da loja</span>
            <input value={address} maxLength={200} disabled={!manage} onChange={(e) => setAddress(e.target.value)} placeholder="Rua, número - bairro, cidade - UF, CEP" />
          </label>
          {manage && <button type="button" className="btn btn-secondary" onClick={locate} disabled={locating || address.trim().length < 5}>{locating ? 'Procurando…' : 'Localizar no mapa'}</button>}
          {found && <p className="hint">Encontrado: {found}</p>}
          <div className="grid-2">
            <label className="field"><span>Latitude</span><input inputMode="decimal" value={lat} disabled={!manage} onChange={(e) => setLat(e.target.value)} placeholder="-23.0896" /></label>
            <label className="field"><span>Longitude</span><input inputMode="decimal" value={lng} disabled={!manage} onChange={(e) => setLng(e.target.value)} placeholder="-47.2149" /></label>
          </div>
          {hasPoint && (
            <p className="small">
              <a href={`https://www.openstreetmap.org/?mlat=${parseNum(lat)}&mlon=${parseNum(lng)}#map=18/${parseNum(lat)}/${parseNum(lng)}`} target="_blank" rel="noreferrer">
                Conferir o ponto no mapa ↗
              </a>{' '}
              <span className="muted">(se estiver errado, copie a latitude e longitude certas do Google Maps: clique com o botão direito no local)</span>
            </p>
          )}
          <h4>Faixas de distância</h4>
          <table className="a-table">
            <thead><tr><th>Até (km)</th><th>Taxa (R$)</th><th /></tr></thead>
            <tbody>
              {tiers.map((t, i) => (
                <tr key={i}>
                  <td><input aria-label={`Faixa ${i + 1} até km`} inputMode="decimal" value={t.km} disabled={!manage} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, km: e.target.value } : x)))} /></td>
                  <td><input aria-label={`Faixa ${i + 1} taxa`} inputMode="decimal" value={t.fee} disabled={!manage} placeholder="0,00" onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, fee: e.target.value } : x)))} /></td>
                  <td>{manage && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>Remover</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {manage && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTiers([...tiers, { km: '', fee: '' }])}>+ Faixa</button>}
          {sorted.length > 0 && (
            <ul className="muted small">
              {sorted.map((t, k) => (
                <li key={t.i}>De {k === 0 ? '0' : kmText(sorted[k - 1].n)} até {kmText(t.n)} km: {t.fee.trim() ? `R$ ${t.fee}` : '—'}</li>
              ))}
              <li>Acima de {kmText(sorted[sorted.length - 1].n)} km: não entregamos</li>
            </ul>
          )}
          {manage && <AddressTest />}
        </>
      )}
      {manage && <button className="btn btn-primary" onClick={save}>Salvar forma de cobrança</button>}
    </section>
  );
}

interface AddressTestResult {
  found: { lat: number; lng: number; label: string; precision: string; provider: string } | null;
  distanceKm: number | null; feeCents: number | null; outOfArea: boolean; storeLocated: boolean;
  trace: { provider: string; query: string; result: string; detail?: string; cached?: boolean }[];
}
const PROVIDER_NAMES: Record<string, string> = { nominatim: 'OpenStreetMap', photon: 'Photon', cep: 'CEP' };

// Testa um endereço de cliente com a regra que o pedido usa (salve antes as faixas e o ponto da loja).
function AddressTest() {
  const toast = useToast();
  const [f, setF] = useState({ cep: '', street: '', number: '', city: '', state: 'SP' });
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AddressTestResult | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function fillCep() {
    const cep = f.cep.replace(/\D/g, '');
    if (cep.length !== 8) return;
    try {
      const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`).then((x) => x.json());
      if (!r.erro) setF((x) => ({ ...x, street: r.logradouro || x.street, city: r.localidade || x.city, state: r.uf || x.state }));
    } catch { /* sem CEP automático: preenche à mão */ }
  }

  async function run() {
    setBusy(true);
    setRes(null);
    try {
      setRes(await api<AddressTestResult>('/api/admin/settings/test-address', { body: f }));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="address-test">
      <h4>Testar um endereço de cliente</h4>
      <p className="muted small">Mostra a distância e a taxa que o pedido teria. Salve a forma de cobrança antes de testar.</p>
      <div className="grid-2">
        <label className="field"><span>CEP</span><input id="t-cep" inputMode="numeric" value={f.cep} onChange={set('cep')} onBlur={fillCep} placeholder="13334-050" /></label>
        <label className="field"><span>Número</span><input id="t-number" value={f.number} onChange={set('number')} /></label>
      </div>
      <label className="field"><span>Rua do cliente</span><input id="t-street" value={f.street} onChange={set('street')} /></label>
      <div className="grid-2">
        <label className="field"><span>Cidade do cliente</span><input id="t-city" value={f.city} onChange={set('city')} /></label>
        <label className="field"><span>UF</span><input id="t-state" value={f.state} maxLength={2} onChange={set('state')} /></label>
      </div>
      <button type="button" className="btn btn-secondary" onClick={run} disabled={busy || f.street.trim().length < 2 || f.city.trim().length < 2}>{busy ? 'Testando…' : 'Testar endereço'}</button>
      {res && (
        <div className="address-test-result" role="status">
          {!res.storeLocated ? <p className="alert alert-warning">A loja ainda não tem latitude e longitude salvas.</p>
            : !res.found ? <p className="alert alert-warning">Endereço não encontrado no mapa. Esse pedido sairia com a taxa do bairro.</p>
            : res.outOfArea ? <p className="alert alert-warning">{kmText(res.distanceKm!)} km da loja: fora das faixas, o pedido seria recusado.</p>
            : <p className="alert alert-info"><strong>{kmText(res.distanceKm!)} km da loja · taxa {res.feeCents == null ? '—' : brl(res.feeCents)}</strong><br />
                Achado: {res.found.label} ({PROVIDER_NAMES[res.found.provider] ?? res.found.provider}{res.found.precision === 'cep' ? ', pelo CEP' : res.found.precision === 'street' ? ', só pela rua' : ''})</p>}
          <ul className="muted small">
            {res.trace.map((t, i) => (
              <li key={i}>{PROVIDER_NAMES[t.provider] ?? t.provider}: {t.result}{t.detail && t.result === 'erro' ? ` (${t.detail})` : ''}{t.cached ? ' (guardado)' : ''}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
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
