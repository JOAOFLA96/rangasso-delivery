import { useCallback, useEffect, useRef, useState } from 'react';
import { api, brl, formatDateTime, formatTime } from '../lib/api';
import { beep, enableSound, useLiveEvents } from './live';
import { STATUS, PRINT, PAYMENT, fmtPhone, type Status, type PrintStatus } from './labels';
import { OrderDetail } from './OrderDetail';
import { useToast } from './ui';

export interface OrderRow {
  id: string; number: number; status: Status; print_status: PrintStatus; customer_name: string; customer_phone: string;
  neighborhood_name: string; street: string; street_number: string; complement: string; payment_method: keyof typeof PAYMENT;
  change_for_cents: number | null; total_cents: number; created_at: string; item_count: number; notes: string;
}

interface Filters { q: string; status: string; printStatus: string; payment: string; from: string; to: string }
const emptyFilters: Filters = { q: '', status: '', printStatus: '', payment: '', from: '', to: '' };

export function OrdersTab() {
  const toast = useToast();
  const [view, setView] = useState<'active' | 'history'>('active');
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailVersion, setDetailVersion] = useState(0);
  const [soundOn, setSoundOn] = useState(false);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    const params = new URLSearchParams({ limit: '100' });
    if (view === 'active') params.set('active', '1');
    else for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    try {
      const r = await api<{ total: number; orders: OrderRow[] }>(`/api/admin/orders?${params}`);
      if (id !== reqId.current) return;
      // Em andamento: mais antigos primeiro (fila de produção).
      setOrders(view === 'active' ? [...r.orders].reverse() : r.orders);
      setTotal(r.total);
      setError(null);
    } catch (e) {
      if (id === reqId.current) setError((e as Error).message);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [view, filters]);

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(load, filters.q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, filters.q]);

  // Reserva: recarrega a cada 60 s mesmo se o tempo real falhar sem aviso.
  useEffect(() => {
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const live = useLiveEvents(
    (type, data) => {
      if (type === 'order.created') {
        beep();
        toast(`Novo pedido #${data.number}`, 'info');
        setNewIds((s) => new Set(s).add(data.orderId));
      }
      if (type !== 'agent.updated' && type !== 'print.queued') {
        load();
        setDetailVersion((v) => v + 1);
      }
    },
    () => {
      load();
      setDetailVersion((v) => v + 1);
    },
  );

  const pendingNew = orders.filter((o) => o.status === 'received').length;
  useEffect(() => {
    document.title = pendingNew ? `(${pendingNew}) Pedidos — Rangasso` : 'Pedidos — Rangasso';
  }, [pendingNew]);

  const open = (id: string) => {
    setSelected(id);
    setNewIds((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  };

  return (
    <div className={`a-orders ${selected ? 'has-detail' : ''}`}>
      <section className="a-list-pane">
        <div className="a-list-head">
          <div className="seg" role="tablist">
            <button role="tab" aria-selected={view === 'active'} className={view === 'active' ? 'on' : ''} onClick={() => setView('active')}>Em andamento</button>
            <button role="tab" aria-selected={view === 'history'} className={view === 'history' ? 'on' : ''} onClick={() => setView('history')}>Histórico</button>
          </div>
          <span className={`live live-${live}`} title="Atualização em tempo real">{live === 'live' ? 'Ao vivo' : live === 'connecting' ? 'Conectando…' : 'Reconectando…'}</span>
          {!soundOn && (
            <button className="btn btn-secondary btn-sm" onClick={() => enableSound().then(() => { setSoundOn(true); beep(); })}>🔔 Ativar som</button>
          )}
        </div>

        {view === 'history' && (
          <div className="a-filters">
            <input type="search" placeholder="Nº do pedido, nome ou telefone" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} aria-label="Buscar" />
            <div className="a-filter-row">
              <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} aria-label="Status">
                <option value="">Todos os status</option>
                {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              <select value={filters.printStatus} onChange={(e) => setFilters({ ...filters, printStatus: e.target.value })} aria-label="Impressão">
                <option value="">Toda impressão</option>
                {Object.entries(PRINT).filter(([k]) => k !== 'cancelled').map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              <select value={filters.payment} onChange={(e) => setFilters({ ...filters, payment: e.target.value })} aria-label="Pagamento">
                <option value="">Todo pagamento</option>
                {Object.entries(PAYMENT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div className="a-filter-row">
              <label className="inline-field"><span>De</span><input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></label>
              <label className="inline-field"><span>Até</span><input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></label>
              <button className="btn btn-ghost btn-sm" onClick={() => setFilters(emptyFilters)}>Limpar</button>
            </div>
          </div>
        )}

        {error && <div className="alert alert-error">{error} <button className="btn btn-link" onClick={load}>Tentar de novo</button></div>}
        {loading && !orders.length ? (
          <p className="muted pad">Carregando pedidos…</p>
        ) : orders.length === 0 ? (
          <div className="state-box"><p className="muted">{view === 'active' ? 'Nenhum pedido em andamento. Os novos aparecem aqui automaticamente.' : 'Nenhum pedido encontrado com esses filtros.'}</p></div>
        ) : (
          <>
            {view === 'history' && <p className="muted small pad">{total} pedido(s){total > orders.length ? `, mostrando ${orders.length}` : ''}</p>}
            <ul className="a-order-list">
              {orders.map((o) => (
                <li key={o.id}>
                  <button className={`a-order-card ${selected === o.id ? 'sel' : ''} ${newIds.has(o.id) ? 'is-new' : ''}`} onClick={() => open(o.id)}>
                    <div className="oc-top">
                      <strong className="oc-num">#{o.number}</strong>
                      <span className={`pill ${STATUS[o.status].cls}`}>{STATUS[o.status].label}</span>
                      <span className="oc-time">{view === 'active' ? formatTime(o.created_at) : formatDateTime(o.created_at)}</span>
                    </div>
                    <div className="oc-mid">
                      <span className="oc-name">{o.customer_name}</span>
                      <span className="muted">{o.neighborhood_name}</span>
                    </div>
                    <div className="oc-bottom">
                      <span>{o.item_count} {o.item_count === 1 ? 'item' : 'itens'} · <strong>{brl(o.total_cents)}</strong> · {PAYMENT[o.payment_method]}</span>
                      <span className={`pill pill-sm ${PRINT[o.print_status].cls}`}>🖨 {PRINT[o.print_status].label}</span>
                    </div>
                    {view === 'active' && <Elapsed since={o.created_at} />}
                    <span className="sr-only">Telefone {fmtPhone(o.customer_phone)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="a-detail-pane">
        {selected ? (
          <OrderDetail id={selected} version={detailVersion} onClose={() => setSelected(null)} onChanged={load} />
        ) : (
          <div className="state-box desktop-only"><p className="muted">Selecione um pedido para ver os detalhes.</p></div>
        )}
      </section>
    </div>
  );
}

function Elapsed({ since }: { since: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const min = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 60000));
  return <span className={`oc-elapsed ${min >= 45 ? 'late' : min >= 30 ? 'warn' : ''}`}>há {min} min</span>;
}
