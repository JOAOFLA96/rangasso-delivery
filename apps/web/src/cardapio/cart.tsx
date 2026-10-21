import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { storage, newKey } from '../lib/api';
import type { CartLine } from './types';

const KEY = 'rangasso.cart.v1';

interface CartCtx {
  lines: CartLine[];
  count: number;
  subtotalCents: number;
  add: (line: Omit<CartLine, 'lineId'>) => void;
  setQty: (lineId: string, qty: number) => void;
  remove: (lineId: string) => void;
  removeProduct: (productId: string) => void;
  clear: () => void;
}

const Ctx = createContext<CartCtx | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(() => storage.get<CartLine[]>(KEY, []));
  useEffect(() => storage.set(KEY, lines), [lines]);

  const value = useMemo<CartCtx>(() => ({
    lines,
    count: lines.reduce((s, l) => s + l.quantity, 0),
    subtotalCents: lines.reduce((s, l) => s + l.unitCents * l.quantity, 0),
    add: (line) =>
      setLines((ls) => {
        // Mesmo produto, mesmos adicionais e mesma observação: soma a quantidade.
        const same = ls.find((l) => l.productId === line.productId && l.notes === line.notes && [...l.addonIds].sort().join() === [...line.addonIds].sort().join());
        if (same) return ls.map((l) => (l === same ? { ...l, quantity: Math.min(99, l.quantity + line.quantity) } : l));
        return [...ls, { ...line, lineId: newKey() }];
      }),
    setQty: (lineId, qty) => setLines((ls) => ls.map((l) => (l.lineId === lineId ? { ...l, quantity: Math.max(1, Math.min(99, qty)) } : l))),
    remove: (lineId) => setLines((ls) => ls.filter((l) => l.lineId !== lineId)),
    removeProduct: (productId) => setLines((ls) => ls.filter((l) => l.productId !== productId)),
    clear: () => setLines([]),
  }), [lines]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCart() {
  const c = useContext(Ctx);
  if (!c) throw new Error('CartProvider ausente');
  return c;
}
