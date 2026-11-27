import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, brl, formatDateTime, formatTime, maskPhone } from '../lib/api';
import { PAYMENT, STATUS, fmtPhone, type Status } from './labels';
import { useLiveEvents } from './live';
import { canManage, useSession } from './session';
import { Confirm, Modal, Toggle, errorText, useToast } from './ui';
import { RUN_COLORS, RunsMap } from './RunsMap';

// Entregas: junta pedidos numa saída do motoboy, o Google ordena as paradas (saindo e voltando à loja) e o motoboy recebe a
// rota no celular (link do Google Maps e mensagem pronta para WhatsApp). Depois, baixa de cada entrega e resumo por motoboy.

interface Courier { id: string; name: string; phone: string; active: boolean }
interface Available {
  id: string; number: number; status: Status; customer_name: string; street: string; street_number: string; complement: string; neighborhood_name: string;
  payment_method: keyof typeof PAYMENT; change_for_cents: number | null; total_cents: number; distance_km: number | null; created_at: string; failed_attempts: number;
}
interface Stop {
  orderId: string; number: number; status: Status; position: number; customerName: string; customerPhone: string; street: string; streetNumber: string;
  complement: string; reference: string; neighborhood: string; paymentMethod: keyof typeof PAYMENT; changeForCents: number | null; totalCents: number;
  legDistanceM: number | null; legDurationS: number | null; etaOffsetS: number | null; outcome: 'delivered' | 'not_delivered' | null; outcomeNote: string;
  outcomeAt: string | null; address: string; lat: number | null; lng: number | null;
}
interface Run {
  id: string; number: number; status: 'planned' | 'out' | 'done' | 'cancelled'; auto?: boolean; polyline: string | null; courierId: string | null; courierName: string | null; courierPhone: string | null;
  routeBy: 'google' | 'google_manual' | 'distance'; routeError: string | null; totalDistanceM: number | null; totalDurationS: number | null;
  createdAt: string; departedAt: string | null; finishedAt: string | null; stops: Stop[]; mapsUrl: string | null;
}
interface DispatchSettings { autoDispatch: boolean; autoDispatchMax: number; store: { lat: number; lng: number } | null }
interface SummaryRow {
  courier_id: string | null; courier_name: string; runs: number; delivered: number; not_delivered: number; delivery_fees_cents: number;
  planned_distance_m: number; avg_ride_min: number | null; avg_total_min: number | null; avg_cycle_min: number | null;
}

const km = (m: number | null) => (m == null ? '—' : `${(m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km`);
const min = (s: number | null) => (s == null ? '—' : `${Math.max(1, Math.round(s / 60))} min`);
const today = () => new Date().toLocaleDateString('sv-SE');
const addSec = (iso: string, s: number) => new Date(new Date(iso).getTime() + s * 1000).toISOString();

function payLine(s: Pick<Stop, 'paymentMethod' | 'changeForCents' | 'totalCents'>) {
  if (s.paymentMethod === 'cash') {
    const change = s.changeForCents && s.changeForCents > s.totalCents ? s.changeForCents - s.totalCents : 0;
    return `Dinheiro: cobrar ${brl(s.totalCents)}${change ? ` (troco para ${brl(s.changeForCents)}: levar ${brl(change)})` : ''}`;
  }
  return `${PAYMENT[s.paymentMethod]}: ${brl(s.totalCents)}`;
}

// Mensagem para o motoboy: paradas na ordem, o que cobrar em cada uma e o link da rota.
export function courierMessage(run: Run) {
  const stops = run.stops.filter((s) => !s.outcome && s.status !== 'cancelled');
  const lines = [`🛵 *Saída #${run.number} — Rangasso*`, `${stops.length} entrega(s)${run.totalDistanceM ? ` · ${km(run.totalDistanceM)} ida e volta` : ''}`, ''];
  stops.forEach((s, i) => {
    lines.push(`*${i + 1}. Pedido #${s.number}* — ${s.customerName}`);
    lines.push(`📍 ${s.street}, ${s.streetNumber}${s.complement ? ` – ${s.complement}` : ''} – ${s.neighborhood}`);
    if (s.reference) lines.push(`Ref.: ${s.reference}`);
    lines.push(`📞 ${fmtPhone(s.customerPhone)}`);
    lines.push(`💰 ${payLine(s)}`);
    lines.push('');
  });
  if (run.mapsUrl) lines.push(`🗺️ Rota no Google Maps: ${run.mapsUrl}`);
  return lines.join('\n');
}
const waUrl = (phone: string | null, text: string) => `https://wa.me/${phone ? '55' + phone.replace(/\D/g, '') : ''}?text=${encodeURIComponent(text)}`;

export function DeliveriesTab() {
  const toast = useToast();
  const { user } = useSession();
  const [available, setAvailable] = useState<Available[]>([]);
  const [google, setGoogle] = useState(true);
  const [maxStops, setMaxStops] = useState(10);
  const [runs, setRuns] = useState<Run[]>([]);
  const [couriers, setCouriers] = useState<Courier[]>([]);
  const [disp, setDisp] = useState<DispatchSettings | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [courierId, setCourierId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCouriers, setShowCouriers] = useState(false);
  const [version, setVersion] = useState(0);
  const [notDelivered, setNotDelivered] = useState<{ run: Run; stop: Stop } | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, r, c, d] = await Promise.all([
        api<{ orders: Available[]; google: boolean; maxStops: number }>('/api/admin/deliveries/available'),
        api<{ runs: Run[] }>('/api/admin/delivery-runs'),
        api<{ couriers: Courier[] }>('/api/admin/couriers'),
        api<DispatchSettings>('/api/admin/deliveries/settings'),
      ]);
      setDisp(d);
      setAvailable(a.orders);
      setGoogle(a.google);
      setMaxStops(a.maxStops);
      setRuns([...r.runs].sort((x, y) => x.number - y.number));
      setCouriers(c.couriers);
      setVersion((v) => v + 1);
      setPicked((p) => new Set([...p].filter((id) => a.orders.some((o) => o.id === id))));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useLiveEvents((type) => { if (type === 'order.created' || type === 'order.updated' || type === 'run.updated') load(); }, load);

  const activeCouriers = couriers.filter((c) => c.active);
  const busyCouriers = new Set(runs.map((r) => r.courierId).filter(Boolean));

  async function act(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    try {
      const r: any = await fn();
      if (r?.routeError) toast(`Rota montada pela distância até a loja (Google: ${r.routeError}). Confira a ordem.`, 'info');
      else if (ok) toast(ok);
      await load();
      return r;
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const create = () => act('create', async () => {
    const r = await api('/api/admin/delivery-runs', { body: { courierId: courierId || null, orderIds: [...picked], optimize: true } });
    setPicked(new Set());
    return r;
  }, 'Rota montada');

  const setStops = (run: Run, ids: string[], optimize: boolean) =>
    act(`stops-${run.id}`, () => api(`/api/admin/delivery-runs/${run.id}`, { method: 'PUT', body: { orderIds: ids, optimize } }), optimize ? 'Rota reotimizada' : 'Ordem atualizada');

  const move = (run: Run, i: number, d: -1 | 1) => {
    const ids = run.stops.map((s) => s.orderId);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    setStops(run, ids, false);
  };

  return (
    <main className="a-main dl-main">
      <div className="a-section-head">
        <h2>Entregas e rotas</h2>
        {canManage(user) && <button className="btn btn-secondary btn-sm" onClick={() => setShowCouriers(true)}>🛵 Motoboys</button>}
      </div>
      {error && <div className="alert alert-error">{error} <button className="btn btn-link" onClick={load}>Tentar de novo</button></div>}
      {!google && <div className="alert alert-warning">Sem a chave do Google Maps, a ordem das paradas é aproximada (pela distância de cada pedido até a loja).</div>}

      <section className="card dl-auto">
        <div className="a-row wrap">
          <Toggle checked={!!disp?.autoDispatch} disabled={!disp || !canManage(user)} label={`Distribuir automaticamente: pedido aceito entra na saída de um motoboy (até ${disp?.autoDispatchMax ?? 5} por saída)`}
            onChange={(v) => disp && act('disp', () => api('/api/admin/deliveries/settings', { method: 'PUT', body: { autoDispatch: v, autoDispatchMax: disp.autoDispatchMax } }), v ? 'Distribuição automática ligada' : 'Distribuição automática desligada')} />
          {canManage(user) && disp && (
            <label className="inline-field"><span>Máximo por saída</span>
              <select value={disp.autoDispatchMax} onChange={(e) => act('disp', () => api('/api/admin/deliveries/settings', { method: 'PUT', body: { autoDispatch: disp.autoDispatch, autoDispatchMax: Number(e.target.value) } }), 'Limite salvo')}>
                {Array.from({ length: maxStops }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          )}
          <button className="btn btn-secondary btn-sm" disabled={busy === 'auto' || !available.length} onClick={() => act('auto', () => api('/api/admin/deliveries/auto', { method: 'POST' }), 'Pedidos distribuídos')}>Distribuir agora</button>
        </div>
        <p className="muted small">Entram sozinhos os pedidos de entrega aceitos (Confirmado, Em preparo ou Saiu). A saída fica montada esperando você clicar em “Motoboy saiu”. Você pode passar pedidos de um motoboy para outro à mão, e aí pode passar do limite.</p>
      </section>

      <section className="card dl-board">
        <h3>Motoboys agora</h3>
        {!couriers.length && <p className="muted">Nenhum motoboy cadastrado.</p>}
        <ul className="dl-board-list">
          {activeCouriers.map((c) => {
            const run = runs.find((r) => r.courierId === c.id);
            const idx = run ? runs.indexOf(run) : -1;
            const left = run ? run.stops.filter((s) => !s.outcome && s.status !== 'cancelled').length : 0;
            return (
              <li key={c.id} className={`dl-board-item ${run ? run.status : 'free'}`}>
                <span className="dl-dot" style={{ background: run ? RUN_COLORS[idx % RUN_COLORS.length] : '#cfc9c4' }} />
                <strong>{c.name}</strong>
                {!run && <span className="pill pill-sm s-done">Livre</span>}
                {run?.status === 'planned' && <span className="pill pill-sm s-preparing">Saída #{run.number} · {run.stops.length} entrega(s) esperando sair</span>}
                {run?.status === 'out' && <span className="pill pill-sm s-out">Na rua desde {formatTime(run.departedAt!)} · faltam {left} de {run.stops.length}</span>}
              </li>
            );
          })}
          {runs.filter((r) => !r.courierId).map((r) => (
            <li key={r.id} className="dl-board-item nocourier">
              <span className="dl-dot" style={{ background: RUN_COLORS[runs.indexOf(r) % RUN_COLORS.length] }} />
              <strong>Saída #{r.number}</strong> <span className="pill pill-sm dl-retry">sem motoboy · {r.stops.length} entrega(s)</span>
            </li>
          ))}
        </ul>
        {runs.length > 0 && <RunsMap runs={runs} store={disp?.store ?? null} />}
        {runs.some((r) => !r.polyline) && <p className="muted small">Saídas montadas sem o Google não aparecem no mapa.</p>}
      </section>

      <section className="card dl-pool">
        <div className="a-block-head">
          <h3>Pedidos para entregar</h3>
          <span className="muted small">{picked.size ? `${picked.size} selecionado(s)` : `${available.length} aguardando motoboy`}</span>
        </div>
        {!available.length ? (
          <p className="muted">Nenhum pedido de entrega esperando motoboy. Pedidos para retirar na loja não aparecem aqui.</p>
        ) : (
          <ul className="dl-list">
            {available.map((o) => (
              <li key={o.id}>
                <label className={`dl-order ${picked.has(o.id) ? 'sel' : ''}`}>
                  <input type="checkbox" checked={picked.has(o.id)} onChange={() => toggle(o.id)} disabled={!picked.has(o.id) && picked.size >= maxStops} />
                  <span className="dl-order-main">
                    <span className="a-row wrap">
                      <strong>#{o.number}</strong>
                      <span className={`pill pill-sm ${STATUS[o.status].cls}`}>{STATUS[o.status].label}</span>
                      <span className="muted small">feito às {formatTime(o.created_at)}</span>
                      {o.failed_attempts > 0 && <span className="pill pill-sm dl-retry">voltou {o.failed_attempts}x sem entregar</span>}
                    </span>
                    <span>{o.customer_name} · <strong>{o.neighborhood_name}</strong></span>
                    <span className="muted small">{o.street}, {o.street_number}{o.complement ? ` – ${o.complement}` : ''}{o.distance_km != null ? ` · ${o.distance_km.toLocaleString('pt-BR')} km da loja` : ''}</span>
                    <span className="small">{brl(o.total_cents)} · {PAYMENT[o.payment_method]}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="dl-create">
          <label className="field">
            <span>Motoboy</span>
            <select value={courierId} onChange={(e) => setCourierId(e.target.value)}>
              <option value="">Escolher depois</option>
              {activeCouriers.map((c) => <option key={c.id} value={c.id}>{c.name}{busyCouriers.has(c.id) ? ' (em outra saída)' : ''}</option>)}
            </select>
          </label>
          <button className="btn btn-primary" disabled={!picked.size || busy === 'create'} onClick={create}>
            {busy === 'create' ? 'Montando rota…' : `Montar rota${picked.size ? ` com ${picked.size}` : ''}`}
          </button>
        </div>
        {!couriers.length && <p className="muted small">Cadastre os motoboys no botão “🛵 Motoboys” para enviar a rota pelo WhatsApp.</p>}
        <p className="muted small">Até {maxStops} pedidos por saída. O Google escolhe a melhor ordem saindo da loja e voltando.</p>
      </section>

      <h3 className="dl-h">Saídas em andamento</h3>
      {!runs.length && <p className="muted">Nenhuma saída em andamento.</p>}
      {runs.map((run) => (
        <RunCard key={run.id} run={run} color={RUN_COLORS[runs.indexOf(run) % RUN_COLORS.length]} others={runs.filter((r) => r.id !== run.id && r.status === 'planned')}
          freeCouriers={activeCouriers.filter((c) => !busyCouriers.has(c.id))}
          onMoveTo={(s, target) => act(`stops-${run.id}`, () => api(`/api/admin/delivery-runs/${run.id}/stops/${s.orderId}/move`, { body: target }), `Pedido #${s.number} passado`)}
          couriers={activeCouriers} busy={busy} picked={[...picked]}
          onCourier={(id) => act(`c-${run.id}`, () => api(`/api/admin/delivery-runs/${run.id}`, { method: 'PUT', body: { courierId: id || null } }), 'Motoboy alterado')}
          onMove={(i, d) => move(run, i, d)}
          onRemove={(s) => setStops(run, run.stops.filter((x) => x.orderId !== s.orderId).map((x) => x.orderId), false)}
          onAddPicked={() => { setStops(run, [...run.stops.map((s) => s.orderId), ...picked], true); setPicked(new Set()); }}
          onOptimize={() => setStops(run, run.stops.map((s) => s.orderId), true)}
          onCancel={() => act(`x-${run.id}`, () => api(`/api/admin/delivery-runs/${run.id}/cancel`, { method: 'POST' }), 'Saída desfeita; pedidos voltaram para a lista')}
          onDepart={() => act(`d-${run.id}`, () => api(`/api/admin/delivery-runs/${run.id}/depart`, { method: 'POST' }), 'Saída registrada: clientes avisados')}
          onDelivered={(s) => act(`s-${s.orderId}`, () => api(`/api/admin/delivery-runs/${run.id}/stops/${s.orderId}`, { body: { outcome: 'delivered' } }), `Pedido #${s.number} entregue`)}
          onNotDelivered={(s) => setNotDelivered({ run, stop: s })}
          onFinish={() => act(`f-${run.id}`, () => api(`/api/admin/delivery-runs/${run.id}/finish`, { method: 'POST' }), 'Motoboy de volta. Saída concluída.')}
        />
      ))}

      <Summary version={version} />

      {showCouriers && <CouriersModal couriers={couriers} onClose={() => setShowCouriers(false)} onChanged={load} />}
      {notDelivered && (
        <Confirm title={`Pedido #${notDelivered.stop.number} não entregue`} confirmLabel="Registrar" requireReason="Motivo (ex.: cliente não atendeu, endereço errado)"
          text="O pedido volta para a lista de pedidos para entregar, para ir em outra saída."
          onClose={() => setNotDelivered(null)}
          onConfirm={async (note) => {
            await act(`s-${notDelivered.stop.orderId}`, () => api(`/api/admin/delivery-runs/${notDelivered.run.id}/stops/${notDelivered.stop.orderId}`, { body: { outcome: 'not_delivered', note } }), 'Registrado');
          }} />
      )}
    </main>
  );
}

function RunCard({ run, color, others, freeCouriers, onMoveTo, couriers, busy, picked, onCourier, onMove, onRemove, onAddPicked, onOptimize, onCancel, onDepart, onDelivered, onNotDelivered, onFinish }: {
  run: Run; color: string; others: Run[]; freeCouriers: Courier[]; onMoveTo: (s: Stop, target: { toRunId?: string; courierId?: string | null }) => void;
  couriers: Courier[]; busy: string | null; picked: string[];
  onCourier: (id: string) => void; onMove: (i: number, d: -1 | 1) => void; onRemove: (s: Stop) => void; onAddPicked: () => void; onOptimize: () => void;
  onCancel: () => void; onDepart: () => void; onDelivered: (s: Stop) => void; onNotDelivered: (s: Stop) => void; onFinish: () => void;
}) {
  const [confirmCancel, setConfirmCancel] = useState(false);
  const planned = run.status === 'planned';
  const open = run.stops.filter((s) => !s.outcome && s.status !== 'cancelled');
  const msg = useMemo(() => courierMessage(run), [run]);
  const courier = couriers.find((c) => c.id === run.courierId);
  const routeNote = run.routeBy === 'google' ? 'Ordem otimizada pelo Google' : run.routeBy === 'google_manual' ? 'Ordem escolhida no painel (medida pelo Google)' : 'Ordem aproximada pela distância até a loja';
  const working = busy?.endsWith(run.id) || busy === `stops-${run.id}`;

  return (
    <section className={`card dl-run ${run.status}`}>
      <div className="a-block-head">
        <h3><span className="dl-dot" style={{ background: color }} />Saída #{run.number}{run.auto ? <span className="pill pill-sm">automática</span> : null} {run.status === 'out' ? <span className="pill pill-sm s-out">Na rua desde {formatTime(run.departedAt!)}</span> : <span className="pill pill-sm s-preparing">Montando</span>}</h3>
        {run.totalDistanceM != null && <span className="muted small">{km(run.totalDistanceM)} ida e volta · {min(run.totalDurationS)} de direção</span>}
      </div>
      <p className={`small ${run.routeBy === 'distance' ? 'dl-warn' : 'muted'}`}>{routeNote}{run.routeError ? ` (Google: ${run.routeError})` : ''}. Tempo sem contar a parada em cada cliente.</p>

      <div className="a-row wrap">
        <label className="inline-field">
          <span>Motoboy</span>
          <select value={run.courierId ?? ''} onChange={(e) => onCourier(e.target.value)} disabled={working}>
            <option value="">— escolher —</option>
            {run.courierId && !courier && <option value={run.courierId}>{run.courierName}</option>}
            {couriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>

      <ol className="dl-stops">
        {run.stops.map((s, i) => (
          <li key={s.orderId} className={`dl-stop ${s.outcome ?? ''} ${s.status === 'cancelled' ? 'cancelled' : ''}`}>
            <span className="dl-pos">{s.position}</span>
            <div className="dl-stop-main">
              <div className="a-row wrap">
                <strong>#{s.number} · {s.customerName}</strong>
                {s.status === 'cancelled' && <span className="pill pill-sm s-cancelled">Cancelado</span>}
                {s.outcome === 'delivered' && <span className="pill pill-sm s-done">Entregue {s.outcomeAt ? formatTime(s.outcomeAt) : ''}</span>}
                {s.outcome === 'not_delivered' && <span className="pill pill-sm s-cancelled">Não entregue: {s.outcomeNote}</span>}
                {!s.outcome && s.etaOffsetS != null && (
                  <span className="muted small">{run.departedAt ? `chega ~${formatTime(addSec(run.departedAt, s.etaOffsetS))}` : `+${min(s.etaOffsetS)} após sair`}{s.legDistanceM != null ? ` · trecho ${km(s.legDistanceM)}` : ''}</span>
                )}
              </div>
              <div>{s.street}, {s.streetNumber}{s.complement ? ` – ${s.complement}` : ''} – <strong>{s.neighborhood}</strong></div>
              {s.reference && <div className="muted small">Ref.: {s.reference}</div>}
              <div className="small">💰 {payLine(s)} · 📞 <a href={`tel:${s.customerPhone}`}>{fmtPhone(s.customerPhone)}</a></div>
            </div>
            <div className="dl-stop-actions">
              {planned && (
                <>
                  <button className="btn btn-ghost btn-sm" aria-label="Subir" disabled={working || i === 0} onClick={() => onMove(i, -1)}>↑</button>
                  <button className="btn btn-ghost btn-sm" aria-label="Descer" disabled={working || i === run.stops.length - 1} onClick={() => onMove(i, 1)}>↓</button>
                  {(others.length > 0 || freeCouriers.length > 0 || run.stops.length > 1) && (
                    <select className="dl-move" aria-label={`Passar pedido #${s.number} para`} value="" disabled={working}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v.startsWith('run:')) onMoveTo(s, { toRunId: v.slice(4) });
                        else if (v.startsWith('new:')) onMoveTo(s, { courierId: v.slice(4) || null });
                      }}>
                      <option value="">Passar para…</option>
                      {others.map((o) => <option key={o.id} value={`run:${o.id}`}>Saída #{o.number} · {o.courierName ?? 'sem motoboy'} ({o.stops.length})</option>)}
                      {freeCouriers.map((c) => <option key={c.id} value={`new:${c.id}`}>Nova saída com {c.name}</option>)}
                      {run.stops.length > 1 && <option value="new:">Nova saída sem motoboy</option>}
                    </select>
                  )}
                  <button className="btn btn-ghost btn-sm" aria-label={`Tirar pedido #${s.number}`} disabled={working || run.stops.length === 1} onClick={() => onRemove(s)}>✕</button>
                </>
              )}
              {run.status === 'out' && !s.outcome && s.status !== 'cancelled' && (
                <>
                  <button className="btn btn-primary btn-sm" disabled={busy === `s-${s.orderId}`} onClick={() => onDelivered(s)}>Entregue</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => onNotDelivered(s)}>Não entregue</button>
                </>
              )}
              {run.status === 'out' && !s.outcome && s.status === 'cancelled' && (
                <button className="btn btn-secondary btn-sm" onClick={() => onNotDelivered(s)}>Dar baixa</button>
              )}
            </div>
          </li>
        ))}
      </ol>

      <div className="dl-run-actions">
        {run.mapsUrl && <a className="btn btn-secondary" href={run.mapsUrl} target="_blank" rel="noreferrer">🗺️ Abrir no Google Maps</a>}
        {open.length > 0 && (
          <a className="btn btn-secondary" href={waUrl(run.courierPhone, msg)} target="_blank" rel="noreferrer"
            title={run.courierPhone ? `Enviar para ${run.courierName}` : 'Motoboy sem telefone: escolha o contato no WhatsApp'}>💬 Enviar ao motoboy</a>
        )}
        <button className="btn btn-ghost" onClick={() => navigator.clipboard?.writeText(msg)}>Copiar mensagem</button>
        {planned && (
          <>
            {picked.length > 0 && <button className="btn btn-secondary" disabled={working || run.stops.length + picked.length > 10} onClick={onAddPicked}>+ Incluir {picked.length} selecionado(s)</button>}
            <button className="btn btn-ghost" disabled={working} onClick={onOptimize}>Reotimizar</button>
            <button className="btn btn-ghost" disabled={working} onClick={() => setConfirmCancel(true)}>Desfazer</button>
            <button className="btn btn-primary btn-grow" disabled={working || !run.courierId} onClick={onDepart}>{run.courierId ? 'Motoboy saiu' : 'Escolha o motoboy'}</button>
          </>
        )}
        {run.status === 'out' && <button className="btn btn-primary btn-grow" disabled={working || open.length > 0} onClick={onFinish} title={open.length ? 'Dê baixa em todas as paradas' : ''}>Motoboy voltou</button>}
      </div>
      {working && <p className="muted small">Atualizando a rota…</p>}
      {confirmCancel && <Confirm title={`Desfazer saída #${run.number}?`} text="Os pedidos voltam para a lista de pedidos para entregar." confirmLabel="Desfazer" onClose={() => setConfirmCancel(false)} onConfirm={onCancel} />}
    </section>
  );
}

function Summary({ version }: { version: number }) {
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [rows, setRows] = useState<SummaryRow[] | null>(null);
  const [history, setHistory] = useState<Run[]>([]);
  const [courier, setCourier] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const c = courier ? `&courierId=${courier}` : '';
    Promise.all([
      api<{ couriers: SummaryRow[] }>(`/api/admin/delivery-runs/summary?from=${from}&to=${to}`),
      api<{ runs: Run[] }>(`/api/admin/delivery-runs?from=${from}&to=${to}${c}`),
    ]).then(([s, h]) => { setRows(s.couriers); setHistory(h.runs); setErr(null); }).catch((e) => setErr(errorText(e)));
  }, [from, to, courier, version]);
  const tot = rows?.reduce((a, r) => ({ d: a.d + r.delivered, n: a.n + r.not_delivered, f: a.f + r.delivery_fees_cents, m: a.m + r.planned_distance_m }), { d: 0, n: 0, f: 0, m: 0 });
  return (
    <section className="card dl-summary">
      <div className="a-block-head">
        <h3>Resumo por motoboy</h3>
        <div className="a-row wrap">
          <label className="inline-field"><span>De</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="inline-field"><span>Até</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
      </div>
      {err && <div className="alert alert-error">{err}</div>}
      {rows && !rows.length && <p className="muted">Nenhuma saída registrada no período.</p>}
      {rows && rows.length > 0 && (
        <div className="dl-table-wrap"><table className="a-table">
          <thead><tr><th>Motoboy</th><th>Saídas</th><th>Entregues</th><th>Não entregues</th><th>Taxas de entrega</th><th>Km previstos</th><th>Saída → entrega</th><th>Pedido → entrega</th><th>Volta média</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.courier_id ?? 'none'} className={courier && courier === r.courier_id ? 'dl-row-sel' : ''}>
                <td><button className="btn btn-link" onClick={() => setCourier(courier === r.courier_id ? '' : r.courier_id ?? '')} title="Ver as entregas deste motoboy">{r.courier_name}</button></td><td>{r.runs}</td><td>{r.delivered}</td><td>{r.not_delivered}</td><td>{brl(r.delivery_fees_cents)}</td>
                <td>{km(r.planned_distance_m || null)}</td><td>{r.avg_ride_min != null ? `${r.avg_ride_min} min` : '—'}</td>
                <td>{r.avg_total_min != null ? `${r.avg_total_min} min` : '—'}</td><td>{r.avg_cycle_min != null ? `${r.avg_cycle_min} min` : '—'}</td>
              </tr>
            ))}
            {rows.length > 1 && tot && <tr className="dl-total"><td>Total</td><td /><td>{tot.d}</td><td>{tot.n}</td><td>{brl(tot.f)}</td><td>{km(tot.m || null)}</td><td colSpan={3} /></tr>}
          </tbody>
        </table></div>
      )}
      <div className="a-block-head dl-hist-head">
        <h3>Entregas de cada saída</h3>
        {courier && <button className="btn btn-ghost btn-sm" onClick={() => setCourier('')}>Ver todos os motoboys</button>}
      </div>
      {!history.length && <p className="muted">Nenhuma saída no período{courier ? ' para este motoboy' : ''}.</p>}
      <ul className="dl-hist">
        {history.map((r) => (
          <li key={r.id}>
            <div className="dl-hist-run">
              <strong>Saída #{r.number} · {r.courierName ?? 'Sem motoboy'}</strong>
              <span className="muted small">
                {r.departedAt && `${formatDateTime(r.departedAt)}`}
                {r.finishedAt && r.departedAt ? ` → voltou ${formatTime(r.finishedAt)} (${Math.round((+new Date(r.finishedAt) - +new Date(r.departedAt)) / 60000)} min)` : r.status === 'out' ? ' · na rua' : ''}
                {r.totalDistanceM != null ? ` · ${km(r.totalDistanceM)}` : ''}
              </span>
            </div>
            <ol className="dl-hist-stops">
              {r.stops.map((s) => (
                <li key={s.orderId}>
                  <span>#{s.number} · {s.customerName} · {s.neighborhood}</span>
                  {s.outcome === 'delivered' ? (
                    <span className="pill pill-sm s-done">Entregue {s.outcomeAt ? formatTime(s.outcomeAt) : ''}{s.outcomeAt && r.departedAt ? ` · ${Math.round((+new Date(s.outcomeAt) - +new Date(r.departedAt)) / 60000)} min após sair` : ''}</span>
                  ) : s.outcome === 'not_delivered' ? (
                    <span className="pill pill-sm s-cancelled">Não entregue: {s.outcomeNote}</span>
                  ) : <span className="pill pill-sm s-out">A caminho</span>}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ul>
      <p className="muted small">“Saída → entrega” e “Pedido → entrega” são médias dos pedidos entregues, medidas pelo horário em que o painel registrou cada baixa. “Volta média” é da saída até o motoboy voltar. Km previstos vêm da rota do Google (ida e volta), não do odômetro.</p>
    </section>
  );
}

function CouriersModal({ couriers, onClose, onChanged }: { couriers: Courier[]; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [edit, setEdit] = useState<Courier | null>(null);
  async function save(c: { id?: string; name: string; phone: string; active: boolean }) {
    try {
      await api(c.id ? `/api/admin/couriers/${c.id}` : '/api/admin/couriers', { method: c.id ? 'PUT' : 'POST', body: { name: c.name, phone: c.phone, active: c.active } });
      toast(c.id ? 'Motoboy atualizado' : 'Motoboy cadastrado');
      onChanged();
      return true;
    } catch (e) {
      toast(errorText(e), 'error');
      return false;
    }
  }
  return (
    <Modal title="Motoboys" onClose={onClose}>
      <form className="dl-courier-form" onSubmit={async (e) => { e.preventDefault(); if (await save({ name, phone, active: true })) { setName(''); setPhone(''); } }}>
        <label className="field"><span>Nome</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required minLength={2} /></label>
        <label className="field"><span>WhatsApp</span><input inputMode="tel" value={phone} onChange={(e) => setPhone(maskPhone(e.target.value))} placeholder="(19) 99999-9999" /></label>
        <button className="btn btn-primary">Adicionar</button>
      </form>
      {!couriers.length && <p className="muted">Nenhum motoboy cadastrado.</p>}
      <table className="a-table">
        <tbody>
          {couriers.map((c) => (
            <tr key={c.id} className={c.active ? '' : 'inactive'}>
              {edit?.id === c.id ? (
                <>
                  <td><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} aria-label="Nome" /></td>
                  <td><input value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: maskPhone(e.target.value) })} aria-label="WhatsApp" /></td>
                  <td><button className="btn btn-primary btn-sm" onClick={async () => { if (await save(edit)) setEdit(null); }}>Salvar</button></td>
                </>
              ) : (
                <>
                  <td>{c.name}{!c.active && ' (desativado)'}</td>
                  <td>{c.phone ? fmtPhone(c.phone) : '—'}</td>
                  <td className="a-row">
                    <button className="btn btn-ghost btn-sm" onClick={() => setEdit({ ...c, phone: c.phone ? maskPhone(c.phone) : '' })}>Editar</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => save({ ...c, active: !c.active })}>{c.active ? 'Desativar' : 'Ativar'}</button>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
