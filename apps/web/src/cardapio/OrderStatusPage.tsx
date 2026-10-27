import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, brl, formatDateTime } from '../lib/api';
import { StoreHeader } from './Header';
import { enablePush, fetchOrder, iosNeedsHomeScreen, isActive, myOrders, PUSH_EVENT, pushEnabledFor, pushSupported, rememberOrder, type PublicOrder } from './orderStore';
import type { StoreInfo } from './types';

const STEPS = [
  ['received', 'Recebido'],
  ['confirmed', 'Confirmado'],
  ['preparing', 'Em preparo'],
  ['out_for_delivery', 'Saiu para entrega'],
  ['completed', 'Entregue'],
] as const;
const PICKUP_STEP_LABELS: Record<string, string> = { out_for_delivery: 'Pronto para retirar', completed: 'Retirado' };

export function OrderStatusPage({ store }: { store: StoreInfo }) {
  const { token } = useParams();
  const [order, setOrder] = useState<PublicOrder | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchOrder(token!)
        .then((o) => {
          if (!alive) return;
          setOrder(o);
          setError(null);
          // Aberto por link (WhatsApp, outro aparelho): passa a aparecer em "Meus pedidos" aqui também.
          if (!myOrders().some((x) => x.token === token)) rememberOrder({ token: token!, number: o.number, at: o.createdAt });
        })
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
  const pickup = order.fulfillment === 'pickup';
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
              <li key={s} className={i < idx ? 'done' : i === idx ? 'current' : ''} aria-current={i === idx ? 'step' : undefined}>{(pickup && PICKUP_STEP_LABELS[s]) || label}</li>
            ))}
          </ol>
        )}

        {isActive(order.status) && <PushCard token={token!} pickup={pickup} />}
        {(order.canReview || order.review) && <ReviewCard token={token!} order={order} onDone={() => fetchOrder(token!).then(setOrder)} />}

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
            {pickup ? <div><span>Retirada na loja</span><span>sem taxa</span></div> : <div><span>Taxa de entrega{order.deliveryDistanceKm != null ? ` (${order.deliveryDistanceKm.toFixed(1).replace('.', ',')} km)` : ''}</span><span>{order.deliveryFeePending ? 'a combinar' : brl(order.deliveryFeeCents)}</span></div>}
            {order.discountCents > 0 && <div><span>Desconto</span><span>− {brl(order.discountCents)}</span></div>}
            <div className="total"><span>{order.deliveryFeePending ? 'Total (sem a taxa)' : 'Total'}</span><strong>{brl(order.totalCents)}</strong></div>
          </div>
          <p><strong>Pagamento:</strong> {order.payment}{order.changeForCents ? ` · troco para ${brl(order.changeForCents)}` : ''}</p>
          {pickup
            ? <p><strong>Retirada na loja:</strong> {store.address || store.name}</p>
            : <p><strong>Entrega:</strong> {order.address}</p>}
        </section>

        {(whatsapp || store.phone) && (
          <p className="center">
            Dúvidas sobre o pedido?{' '}
            {whatsapp ? <a href={`https://wa.me/55${whatsapp}?text=${encodeURIComponent(`Olá! Sobre o pedido #${order.number}`)}`} target="_blank" rel="noreferrer">Fale no WhatsApp</a> : <a href={`tel:${store.phone.replace(/\D/g, '')}`}>{store.phone}</a>}
          </p>
        )}
        <p className="center">
          <Link to="/cardapio" className="btn btn-secondary">Voltar ao cardápio</Link>{' '}
          <Link to="/cardapio/pedidos" className="btn btn-secondary">Meus pedidos</Link>
        </p>
      </main>
    </div>
  );
}

function PushCard({ token, pickup }: { token: string; pickup: boolean }) {
  const when = pickup ? 'quando estiver pronto para retirar' : 'quando sair para entrega';
  const [on, setOn] = useState(() => pushEnabledFor(token));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Os avisos podem ter sido ligados ao enviar o pedido (a inscrição termina depois que esta tela abre).
  useEffect(() => {
    const check = () => setOn(pushEnabledFor(token));
    window.addEventListener(PUSH_EVENT, check);
    return () => window.removeEventListener(PUSH_EVENT, check);
  }, [token]);
  if (on) return <p className="alert alert-ok small" role="status">🔔 Avisos ativados: você recebe uma notificação quando o pedido for aceito e {when}.</p>;
  if (!pushSupported()) {
    return iosNeedsHomeScreen() ? (
      <p className="alert alert-info small">
        🔔 Para receber avisos no iPhone: toque em <strong>Compartilhar</strong> › <strong>Adicionar à Tela de Início</strong>, abra o Rangasso por lá e
        ative os avisos nesta página. Enquanto isso, esta página se atualiza sozinha.
      </p>
    ) : null;
  }
  async function activate() {
    setBusy(true);
    setErr(null);
    try {
      await enablePush(token);
      setOn(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card push-card">
      <p><strong>Quer ser avisado no celular?</strong> Mandamos uma notificação quando o pedido for aceito e {when}.</p>
      <button type="button" className="btn btn-primary" onClick={activate} disabled={busy}>{busy ? 'Ativando…' : '🔔 Ativar avisos'}</button>
      {err && <p className="field-error" role="alert">{err}</p>}
    </section>
  );
}

const STAR_LABELS = ['', 'Ruim', 'Regular', 'Bom', 'Muito bom', 'Excelente'];

export function Stars({ value, size = 'md' }: { value: number; size?: 'sm' | 'md' }) {
  return (
    <span className={`stars stars-${size}`} role="img" aria-label={`${value} de 5 estrelas`}>
      {[1, 2, 3, 4, 5].map((n) => <span key={n} className={n <= value ? 'on' : ''} aria-hidden="true">★</span>)}
    </span>
  );
}

function ReviewCard({ token, order, onDone }: { token: string; order: PublicOrder; onDone: () => void }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!photo) return setPreview(null);
    const u = URL.createObjectURL(photo);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [photo]);

  if (order.review) {
    return (
      <section className="card review-card">
        <h2>Sua avaliação</h2>
        <Stars value={order.review.rating} />
        {order.review.comment && <p>{order.review.comment}</p>}
        {order.review.photoUrl && <img className="review-photo" src={order.review.photoUrl} alt="Foto enviada na avaliação" />}
        <p className="muted small">Obrigado por avaliar!</p>
      </section>
    );
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!rating) return setErr('Escolha de 1 a 5 estrelas.');
    if (photo && photo.size > 8 * 1024 * 1024) return setErr('Foto maior que 8 MB.');
    const form = new FormData();
    form.append('rating', String(rating));
    form.append('comment', comment.trim());
    if (photo) form.append('photo', photo);
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/public/orders/${token}/review`, { form });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card review-card">
      <h2>Como foi seu pedido?</h2>
      <form onSubmit={submit}>
        <div className="star-input" role="radiogroup" aria-label="Nota de 1 a 5 estrelas">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} estrela${n > 1 ? 's' : ''}: ${STAR_LABELS[n]}`}
              className={n <= rating ? 'on' : ''} onClick={() => setRating(n)}>★</button>
          ))}
          {rating > 0 && <span className="muted small">{STAR_LABELS[rating]}</span>}
        </div>
        <label className="field">
          <span>Comentário <em className="muted">(opcional)</em></span>
          <textarea id="f-review-comment" rows={3} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Conte o que achou do lanche e da entrega" />
        </label>
        <label className="field">
          <span>Foto <em className="muted">(opcional)</em></span>
          <input id="f-review-photo" type="file" accept="image/*" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
        </label>
        {preview && <img className="review-photo" src={preview} alt="Prévia da foto" />}
        {err && <p className="field-error" role="alert">{err}</p>}
        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>{busy ? 'Enviando…' : 'Enviar avaliação'}</button>
      </form>
    </section>
  );
}
