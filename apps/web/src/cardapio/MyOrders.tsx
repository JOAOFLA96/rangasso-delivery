import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, brl, formatDateTime } from '../lib/api';
import { StoreHeader } from './Header';
import { fetchOrder, forgetOrder, isActive, myOrders, type PublicOrder } from './orderStore';
import type { StoreInfo } from './types';

type Loaded = { token: string; order: PublicOrder };

// Busca os pedidos guardados neste aparelho (mais recentes primeiro). Pedido que não existe mais sai da lista.
function useMyOrders(limit: number, maxAgeDays: number) {
  const [list, setList] = useState<Loaded[] | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    const since = Date.now() - maxAgeDays * 86400_000;
    const refs = myOrders().filter((o) => new Date(o.at).getTime() >= since).slice(0, limit);
    Promise.all(
      refs.map((r) =>
        fetchOrder(r.token, ctrl.signal)
          .then((order) => ({ token: r.token, order }))
          .catch((e) => {
            if (e instanceof ApiError && e.status === 404) forgetOrder(r.token);
            return null;
          }),
      ),
    ).then((all) => !ctrl.signal.aborted && setList(all.filter(Boolean) as Loaded[]));
    return () => ctrl.abort();
  }, [limit, maxAgeDays]);
  return list;
}

// Faixa no topo do cardápio: pedidos em andamento e entregues aguardando avaliação.
export function RecentOrders() {
  const list = useMyOrders(5, 3);
  const show = (list ?? []).filter(({ order }) => isActive(order.status) || order.canReview);
  if (!show.length) return null;
  return (
    <section className="recent-orders" aria-label="Seus pedidos">
      {show.map(({ token, order }) => (
        <Link key={token} to={`/cardapio/pedido/${token}`} className={`recent-order ${isActive(order.status) ? 'active' : ''}`}>
          <span><strong>Pedido #{order.number}</strong> · {order.statusLabel}</span>
          <span className="ro-action">{isActive(order.status) ? 'Acompanhar ›' : '⭐ Avaliar ›'}</span>
        </Link>
      ))}
    </section>
  );
}

export function MyOrdersPage({ store }: { store: StoreInfo }) {
  const list = useMyOrders(20, 365);
  return (
    <div className="c-shell">
      <StoreHeader store={store} compact />
      <main className="c-main">
        <Link to="/cardapio" className="back-link">← Voltar ao cardápio</Link>
        <h1>Meus pedidos</h1>
        <p className="muted small">Pedidos feitos neste aparelho.</p>
        {list == null ? (
          <p className="muted">Carregando…</p>
        ) : list.length === 0 ? (
          <div className="state-box"><p className="muted">Nenhum pedido feito neste aparelho ainda.</p></div>
        ) : (
          <ul className="my-orders">
            {list.map(({ token, order }) => (
              <li key={token}>
                <Link to={`/cardapio/pedido/${token}`} className="card my-order">
                  <div>
                    <strong>Pedido #{order.number}</strong>
                    <span className={`tag ${order.status === 'cancelled' ? 'tag-off' : isActive(order.status) ? 'tag-promo' : ''}`}>{order.statusLabel}</span>
                  </div>
                  <span className="muted small">{formatDateTime(order.createdAt)} · {order.items.reduce((n, i) => n + i.quantity, 0)} item(ns) · {brl(order.totalCents)}</span>
                  <span className="small">{order.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}</span>
                  {order.canReview && <span className="ro-action">⭐ Avaliar este pedido ›</span>}
                  {order.review && <span className="muted small">Você avaliou: {'★'.repeat(order.review.rating)}{'☆'.repeat(5 - order.review.rating)}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
