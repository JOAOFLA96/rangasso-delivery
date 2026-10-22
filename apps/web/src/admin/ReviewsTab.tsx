import { useCallback, useEffect, useState } from 'react';
import { api, formatDateTime } from '../lib/api';
import { Stars } from '../cardapio/OrderStatusPage';
import { canManage, useSession } from './session';
import { errorText, useToast } from './ui';

interface Review {
  id: string; rating: number; comment: string; photoUrl: string | null; hidden: boolean; createdAt: string;
  orderId: string; orderNumber: number; customerName: string; neighborhood: string;
}
interface ReviewsData { summary: { count: number; average: number; distribution: Record<string, number> }; reviews: Review[] }

export function ReviewsTab() {
  const { user } = useSession();
  const toast = useToast();
  const [data, setData] = useState<ReviewsData | null>(null);
  const [more, setMore] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<ReviewsData>('/api/admin/reviews');
      setData(d);
      setMore(d.reviews.length === 50);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function loadMore() {
    if (!data?.reviews.length) return;
    const last = data.reviews[data.reviews.length - 1].createdAt;
    const d = await api<ReviewsData>(`/api/admin/reviews?before=${encodeURIComponent(last)}`);
    setData({ ...data, reviews: [...data.reviews, ...d.reviews] });
    setMore(d.reviews.length === 50);
  }

  async function toggle(r: Review) {
    try {
      await api(`/api/admin/reviews/${r.id}/visibility`, { body: { hidden: !r.hidden } });
      setData((d) => d && { ...d, reviews: d.reviews.map((x) => (x.id === r.id ? { ...x, hidden: !r.hidden } : x)) });
      toast(r.hidden ? 'Avaliação visível de novo' : 'Avaliação ocultada');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  if (error) return <main className="a-main"><div className="alert alert-error">{error}</div></main>;
  if (!data) return <main className="a-main"><p className="muted">Carregando…</p></main>;
  const { summary } = data;
  return (
    <main className="a-main">
      <h2>Avaliações dos clientes</h2>
      <section className="card rating-summary">
        <div>
          <div className="rating-big">{summary.count ? summary.average.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '—'}</div>
          <Stars value={Math.round(summary.average)} />
          <p className="muted small">{summary.count} avaliação(ões)</p>
        </div>
        <div className="rating-bars">
          {[5, 4, 3, 2, 1].map((n) => {
            const c = summary.distribution[n] ?? 0;
            return (
              <div key={n} className="rating-bar">
                <span>{n}★</span>
                <div><span style={{ width: `${summary.count ? (c / summary.count) * 100 : 0}%` }} /></div>
                <span className="muted">{c}</span>
              </div>
            );
          })}
        </div>
      </section>
      {!data.reviews.length && <p className="muted">Ainda não há avaliações. O cliente pode avaliar pela página do pedido depois que ele for marcado como entregue.</p>}
      <ul className="review-list">
        {data.reviews.map((r) => (
          <li key={r.id} className={`card review-item ${r.hidden ? 'hidden-review' : ''}`}>
            <div className="review-head">
              <span><Stars value={r.rating} size="sm" /> <strong>Pedido #{r.orderNumber}</strong> · {r.customerName.split(' ')[0]}{r.neighborhood ? ` · ${r.neighborhood}` : ''}</span>
              <span className="muted small">{formatDateTime(r.createdAt)}{r.hidden ? ' · oculta' : ''}</span>
            </div>
            {r.comment && <p>{r.comment}</p>}
            {r.photoUrl && <a href={r.photoUrl} target="_blank" rel="noreferrer"><img className="review-photo" src={r.photoUrl} alt={`Foto da avaliação do pedido ${r.orderNumber}`} loading="lazy" /></a>}
            {canManage(user) && (
              <button className="btn btn-secondary btn-sm" onClick={() => toggle(r)}>{r.hidden ? 'Mostrar de novo' : 'Ocultar'}</button>
            )}
          </li>
        ))}
      </ul>
      {more && data.reviews.length > 0 && <button className="btn btn-secondary" onClick={loadMore}>Carregar mais</button>}
    </main>
  );
}
