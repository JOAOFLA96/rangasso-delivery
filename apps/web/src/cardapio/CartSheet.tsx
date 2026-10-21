import { useEffect } from 'react';
import { brl } from '../lib/api';
import { useCart } from './cart';
import type { StoreInfo } from './types';

export function CartLines({ editable = true }: { editable?: boolean }) {
  const cart = useCart();
  return (
    <ul className="cart-lines">
      {cart.lines.map((l) => (
        <li key={l.lineId} className="cart-line">
          <div className="cl-main">
            <strong>{editable ? '' : `${l.quantity}× `}{l.name}</strong>
            {l.addonNames.length > 0 && <span className="muted small">{l.addonNames.join(', ')}</span>}
            {l.notes && <span className="muted small">Obs.: {l.notes}</span>}
            <span className="cl-price">{brl(l.unitCents * l.quantity)}</span>
          </div>
          {editable && (
            <div className="cl-actions">
              <div className="stepper small">
                {l.quantity > 1 ? (
                  <button onClick={() => cart.setQty(l.lineId, l.quantity - 1)} aria-label={`Diminuir ${l.name}`}>−</button>
                ) : (
                  <button onClick={() => cart.remove(l.lineId)} aria-label={`Remover ${l.name}`}>🗑</button>
                )}
                <span>{l.quantity}</span>
                <button onClick={() => cart.setQty(l.lineId, l.quantity + 1)} aria-label={`Aumentar ${l.name}`} disabled={l.quantity >= 99}>+</button>
              </div>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function CartSheet({ store, onClose, onCheckout }: { store: StoreInfo; onClose: () => void; onCheckout: () => void }) {
  const cart = useCart();
  useEffect(() => {
    document.body.classList.add('no-scroll');
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.classList.remove('no-scroll');
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  useEffect(() => {
    if (cart.count === 0) onClose();
  }, [cart.count, onClose]);

  const belowMin = cart.subtotalCents < store.minOrderCents;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="cart-title" onClick={(e) => e.stopPropagation()}>
        <button className="sheet-close" onClick={onClose} aria-label="Fechar">×</button>
        <div className="sheet-body">
          <h2 id="cart-title">Seu pedido</h2>
          <CartLines />
          <div className="totals">
            <div><span>Subtotal</span><strong>{brl(cart.subtotalCents)}</strong></div>
            <div className="muted small"><span>Taxa de entrega</span><span>calculada pelo bairro</span></div>
          </div>
          {belowMin && <p className="alert alert-info">Faltam {brl(store.minOrderCents - cart.subtotalCents)} para o pedido mínimo de {brl(store.minOrderCents)}.</p>}
          <button className="btn btn-link" onClick={() => confirm('Esvaziar o carrinho?') && cart.clear()}>Esvaziar carrinho</button>
        </div>
        <div className="sheet-footer">
          <button className="btn btn-secondary" onClick={onClose}>Continuar comprando</button>
          <button className="btn btn-primary btn-grow" disabled={!store.open || belowMin} onClick={onCheckout}>
            {store.open ? 'Finalizar pedido' : 'Loja fechada'}
          </button>
        </div>
      </div>
    </div>
  );
}
