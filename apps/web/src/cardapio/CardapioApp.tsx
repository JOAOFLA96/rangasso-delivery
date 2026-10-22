import { useCallback, useEffect, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { api } from '../lib/api';
import { CartProvider } from './cart';
import { MenuPage } from './MenuPage';
import { CheckoutPage } from './CheckoutPage';
import { MyOrdersPage } from './MyOrders';
import { OrderStatusPage } from './OrderStatusPage';
import { PrivacyPage } from './PrivacyPage';
import type { Category, StoreInfo } from './types';

export interface MenuData { store: StoreInfo; categories: Category[] }

export function CardapioApp() {
  const [data, setData] = useState<MenuData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [store, menu] = await Promise.all([api<StoreInfo>('/api/public/store'), api<{ categories: Category[] }>('/api/public/menu')]);
      setData({ store, categories: menu.categories });
      setError(null);
      document.title = `${store.name} — Delivery`;
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    // Atualiza cardápio e status da loja periodicamente e ao voltar para a aba.
    const t = setInterval(load, 120_000);
    const onVis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load]);

  if (!data) {
    return (
      <div className="c-shell">
        <div className="state-box">
          {error ? (
            <>
              <p>{error}</p>
              <button className="btn btn-primary" onClick={load}>Tentar novamente</button>
            </>
          ) : (
            <p className="muted">Carregando cardápio…</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <CartProvider>
      <Routes>
        <Route index element={<MenuPage data={data} />} />
        <Route path="checkout" element={<CheckoutPage data={data} reload={load} />} />
        <Route path="pedido/:token" element={<OrderStatusPage store={data.store} />} />
        <Route path="pedidos" element={<MyOrdersPage store={data.store} />} />
        <Route path="privacidade" element={<PrivacyPage store={data.store} />} />
        <Route path="*" element={<MenuPage data={data} />} />
      </Routes>
    </CartProvider>
  );
}
