import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, brl, formatDateTime } from '../lib/api';
import { StoreHeader } from './Header';
import type { StoreInfo } from './types';

interface PublicOrder {
  number: number; status: string; statusLabel: string; createdAt: string; customerName: string; address: string;
  items: { quantity: number; name: string; lineTotalCents: number; notes: string; addons: string[] }[];
  subtotalCents: number; deliveryFeeCents: number; discountCents: number; totalCents: number; payment: string;
  changeForCents: number | null; cancelReason: string | null;
}

const STEPS = [
  ['received', 'Recebido'],
  ['confirmed', 'Confirmado'],
  ['preparing', 'Em preparo'],
  ['out_for_delivery', 'Saiu para entrega'],
  ['completed', 'Entregue'],
] as const;

export function OrderStatusPage({ store }: { store: StoreInfo }) {
  const { token } = useParams();
  const [order, setOrder] = useState<PublicOrder | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<PublicOrder>(`/api/public/orders/${token}`)
        .then((o) => alive && (setOrder(o), setError(null)))
        .catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [token]);

  if (!order) {
    return (
      <div className="c-shell">
        <StoreHeader store={store} compact />
        <div className="state-box">{error ? <p>{error}</p> : <p className="muted">Carregando pedido…</p>}</div>
      </div>
    );
  }

  const idx = STEPS.findIndex(([s]) => s === order.status);
  const whatsapp = store.whatsapp.replace(/\D/g, '');
  return (
    <div className="c-shell">
      <StoreHeader store={store} compact />
      <main className="c-main">
        <div className="confirm-hero">
          <p className="muted">Pedido</p>
          <p className="order-number">#{order.number}</p>
          <p>{order.status === 'cancelled' ? 'Pedido cancelado' : `Obrigado, ${order.customerName.split(' ')[0]}! Recebemos seu pedido.`}</p>
          <p className="muted small">Feito em {formatDateTime(order.createdAt)}. Esta página atualiza sozinha.</p>
        </div>

        {order.status === 'cancelled' ? (
          <div className="alert alert-error">Este pedido foi cancelado{order.cancelReason ? `: ${order.cancelReason}` : '.'}</div>
        ) : (
          <ol className="steps" aria-label="Andamento do pedido">
            {STEPS.map(([s, label], i) => (
              <li key={s} className={i < idx ? 'done' : i === idx ? 'current' : ''} aria-current={i === idx ? 'step' : undefined}>{label}</li>
            ))}
          </ol>
        )}

        <section className="card">
          <h2>Resumo</h2>
          <ul className="cart-lines">
            {order.items.map((i, k) => (
              <li key={k} className="cart-line">
                <div className="cl-main">
                  <strong>{i.quantity}× {i.name}</strong>
                  {i.addons.length > 0 && <span className="muted small">{i.addons.join(', ')}</span>}
                  {i.notes && <span className="muted small">Obs.: {i.notes}</span>}
                  <span className="cl-price">{brl(i.lineTotalCents)}</span>
                </div>
              </li>
            ))}
          </ul>
          <div className="totals">
            <div><span>Subtotal</span><span>{brl(order.subtotalCents)}</span></div>
            <div><span>Taxa de entrega</span><span>{brl(order.deliveryFeeCents)}</span></div>
            {order.discountCents > 0 && <div><span>Desconto</span><span>− {brl(order.discountCents)}</span></div>}
            <div className="total"><span>Total</span><strong>{brl(order.totalCents)}</strong></div>
          </div>
          <p><strong>Pagamento:</strong> {order.payment}{order.changeForCents ? ` · troco para ${brl(order.changeForCents)}` : ''}</p>
          <p><strong>Entrega:</strong> {order.address}</p>
        </section>

        {(whatsapp || store.phone) && (
          <p className="center">
            Dúvidas sobre o pedido?{' '}
            {whatsapp ? <a href={`https://wa.me/55${whatsapp}?text=${encodeURIComponent(`Olá! Sobre o pedido #${order.number}`)}`} target="_blank" rel="noreferrer">Fale no WhatsApp</a> : <a href={`tel:${store.phone.replace(/\D/g, '')}`}>{store.phone}</a>}
          </p>
        )}
        <p className="center"><Link to="/cardapio" className="btn btn-secondary">Voltar ao cardápio</Link></p>
      </main>
    </div>
  );
}
