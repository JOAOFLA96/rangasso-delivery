import { useEffect, useMemo, useRef, useState } from 'react';
import { brl } from '../lib/api';
import type { Product } from './types';
import { useCart } from './cart';

export function ProductSheet({ product, onClose, canOrder }: { product: Product; onClose: () => void; canOrder: boolean }) {
  const cart = useCart();
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState('');
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [showErrors, setShowErrors] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  }, [onClose]);

  const toggle = (groupId: string, addonId: string, max: number) =>
    setSelected((s) => {
      const cur = s[groupId] ?? [];
      if (cur.includes(addonId)) return { ...s, [groupId]: cur.filter((x) => x !== addonId) };
      if (max === 1) return { ...s, [groupId]: [addonId] };
      if (cur.length >= max) return s;
      return { ...s, [groupId]: [...cur, addonId] };
    });

  const missing = product.addonGroups.filter((g) => (selected[g.id]?.length ?? 0) < g.minSelect);
  const addonIds = Object.values(selected).flat();
  const allAddons = product.addonGroups.flatMap((g) => g.addons);
  const addonsCents = addonIds.reduce((s, id) => s + (allAddons.find((a) => a.id === id)?.priceCents ?? 0), 0);
  const unit = product.effectivePriceCents + addonsCents;
  const maxQty = useMemo(() => (product.stockLeft != null ? Math.max(1, Math.min(99, product.stockLeft)) : 99), [product.stockLeft]);

  function add() {
    if (missing.length) {
      setShowErrors(true);
      document.getElementById(`group-${missing[0].id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    cart.add({
      productId: product.id,
      name: product.name,
      quantity: qty,
      notes: notes.trim(),
      addonIds,
      addonNames: addonIds.map((id) => allAddons.find((a) => a.id === id)?.name ?? ''),
      unitCents: unit,
    });
    onClose();
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="ps-title" tabIndex={-1} ref={dialogRef} onClick={(e) => e.stopPropagation()}>
        <button className="sheet-close" onClick={onClose} aria-label="Fechar">×</button>
        <div className="sheet-body">
          {product.imageUrl && <img className="ps-image" src={product.imageUrl} alt="" />}
          <h2 id="ps-title" className="ps-title">{product.name}</h2>
          {product.description && <p className="muted ps-desc">{product.description}</p>}
          <p className="ps-price">
            {product.promo && <s className="muted">{brl(product.priceCents)}</s>} <strong>{brl(product.effectivePriceCents)}</strong>
          </p>

          {product.addonGroups.map((g) => {
            const cur = selected[g.id] ?? [];
            const err = showErrors && cur.length < g.minSelect;
            const rule = g.minSelect > 0 ? (g.maxSelect === 1 ? 'Escolha 1' : `Escolha de ${g.minSelect} a ${g.maxSelect}`) : g.maxSelect === 1 ? 'Opcional, até 1' : `Opcional, até ${g.maxSelect}`;
            return (
              <fieldset key={g.id} id={`group-${g.id}`} className={`addon-group ${err ? 'has-error' : ''}`}>
                <legend>
                  <span>{g.name}</span>
                  <span className={`tag ${g.minSelect > 0 ? 'tag-required' : ''}`}>{g.minSelect > 0 ? 'Obrigatório' : 'Opcional'}</span>
                </legend>
                <p className="muted small">{rule}</p>
                {g.addons.map((a) => {
                  const checked = cur.includes(a.id);
                  const disabled = !a.available || (!checked && g.maxSelect > 1 && cur.length >= g.maxSelect);
                  return (
                    <label key={a.id} className={`addon-option ${disabled && !checked ? 'disabled' : ''}`}>
                      <input
                        type={g.maxSelect === 1 ? 'radio' : 'checkbox'}
                        name={g.id}
                        checked={checked}
                        disabled={!a.available}
                        onChange={() => toggle(g.id, a.id, g.maxSelect)}
                        onClick={() => g.maxSelect === 1 && checked && g.minSelect === 0 && toggle(g.id, a.id, g.maxSelect)}
                      />
                      <span className="addon-name">{a.name}{!a.available && ' (indisponível)'}</span>
                      {a.priceCents > 0 && <span className="addon-price">+ {brl(a.priceCents)}</span>}
                    </label>
                  );
                })}
                {err && <p className="field-error">Escolha uma opção para continuar.</p>}
              </fieldset>
            );
          })}

          <label className="field">
            <span>Alguma observação?</span>
            <textarea maxLength={140} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ex.: sem cebola" />
          </label>
        </div>
        <div className="sheet-footer">
          <div className="stepper" aria-label="Quantidade">
            <button onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Diminuir" disabled={qty <= 1}>−</button>
            <span aria-live="polite">{qty}</span>
            <button onClick={() => setQty((q) => Math.min(maxQty, q + 1))} aria-label="Aumentar" disabled={qty >= maxQty}>+</button>
          </div>
          <button className="btn btn-primary btn-grow" onClick={add} disabled={!product.available || !canOrder}>
            {!product.available ? 'Indisponível' : !canOrder ? 'Loja fechada' : `Adicionar · ${brl(unit * qty)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
