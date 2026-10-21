import { Link } from 'react-router-dom';
import type { StoreInfo } from './types';

export function StoreHeader({ store, compact = false }: { store: StoreInfo; compact?: boolean }) {
  return (
    <header className={`c-header ${compact ? 'compact' : ''}`}>
      <Link to="/cardapio" className="c-logo" aria-label={`${store.name} — início`}>
        <img src={store.logoUrl ?? '/brand/logo-rangasso-trim.png'} alt={store.name} />
      </Link>
      {!compact && (
        <div className="c-store-meta">
          <span className={`badge ${store.open ? 'badge-open' : 'badge-closed'}`}>{store.open ? 'Aberto agora' : 'Fechado'}</span>
          {store.open && <span>Entrega em {store.eta.min}–{store.eta.max} min</span>}
        </div>
      )}
    </header>
  );
}
