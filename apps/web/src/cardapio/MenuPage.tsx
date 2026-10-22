import { RecentOrders } from './MyOrders';
import { myOrders } from './orderStore';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { brl, normalize } from '../lib/api';
import type { MenuData } from './CardapioApp';
import { useCart } from './cart';
import { StoreHeader } from './Header';
import { ProductSheet } from './ProductSheet';
import { CartSheet } from './CartSheet';
import type { Product } from './types';

export function MenuPage({ data }: { data: MenuData }) {
  const { store, categories } = data;
  const cart = useCart();
  const navigate = useNavigate();
  const [product, setProduct] = useState<Product | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeCat, setActiveCat] = useState(categories[0]?.id);
  const chipsRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = normalize(query);
    if (!q) return categories;
    return categories
      .map((c) => ({ ...c, products: c.products.filter((p) => normalize(`${p.name} ${p.description}`).includes(q)) }))
      .filter((c) => c.products.length);
  }, [categories, query]);

  // Destaca a categoria visível enquanto rola a página.
  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (vis) setActiveCat(vis.target.id.replace('cat-', ''));
      },
      { rootMargin: '-120px 0px -60% 0px' },
    );
    document.querySelectorAll('.c-category').forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [filtered]);

  useEffect(() => {
    chipsRef.current?.querySelector(`[data-cat="${activeCat}"]`)?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [activeCat]);

  const goTo = (id: string) => {
    const el = document.getElementById(`cat-${id}`);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 110, behavior: 'smooth' });
  };

  return (
    <div className="c-shell">
      <StoreHeader store={store} />
      <main className="c-main">
        {!store.open && (
          <div className="alert alert-warning" role="status">
            <strong>{store.closedMessage ?? 'Estamos fechados no momento.'}</strong>
            {store.nextOpening && <span> Abrimos {store.nextOpening}.</span>}
            <span> Você pode ver o cardápio, mas os pedidos estão pausados.</span>
          </div>
        )}
        <RecentOrders />
        {store.menuMessage && <p className="c-message">{store.menuMessage}</p>}
        <div className="c-info-row">
          {store.minOrderCents > 0 && <span>Pedido mínimo {brl(store.minOrderCents)}</span>}
          {myOrders().length > 0 && <Link to="/cardapio/pedidos">Meus pedidos</Link>}
          <Link to="/cardapio/privacidade">Privacidade</Link>
        </div>

        <div className="c-sticky">
          <input
            className="search"
            type="search"
            placeholder="Buscar no cardápio"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Buscar no cardápio"
          />
          {!query && (
            <nav className="chips" ref={chipsRef} aria-label="Categorias">
              {categories.map((c) => (
                <button key={c.id} data-cat={c.id} className={`chip ${activeCat === c.id ? 'active' : ''}`} onClick={() => goTo(c.id)}>
                  {c.name}
                </button>
              ))}
            </nav>
          )}
        </div>

        {filtered.length === 0 && (
          <div className="state-box">
            <p className="muted">{categories.length === 0 ? 'O cardápio ainda está sendo preparado.' : 'Nenhum item encontrado.'}</p>
          </div>
        )}

        {filtered.map((c) => (
          <section key={c.id} id={`cat-${c.id}`} className="c-category">
            <h2>{c.name}</h2>
            {c.description && <p className="muted small">{c.description}</p>}
            <ul className="product-list">
              {c.products.map((p) => (
                <li key={p.id}>
                  <button className={`product-card ${p.available ? '' : 'unavailable'}`} onClick={() => setProduct(p)} aria-label={`${p.name}, ${brl(p.effectivePriceCents)}${p.available ? '' : ', indisponível'}`}>
                    <div className="pc-text">
                      <h3>{p.name}</h3>
                      {p.description && <p className="pc-desc">{p.description}</p>}
                      <p className="pc-price">
                        {p.promo && <s>{brl(p.priceCents)}</s>}
                        <strong className={p.promo ? 'promo' : ''}>{brl(p.effectivePriceCents)}</strong>
                        {!p.available && <span className="tag tag-off">Indisponível</span>}
                        {p.promo && p.available && <span className="tag tag-promo">Promoção</span>}
                      </p>
                    </div>
                    {p.imageUrl && <img className="pc-img" src={p.imageUrl} alt="" loading="lazy" width={96} height={96} />}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <footer className="c-footer">
          {store.address && <p>{store.address}</p>}
          {store.phone && <p>Telefone: <a href={`tel:${store.phone.replace(/\D/g, '')}`}>{store.phone}</a></p>}
          {store.hours.length > 0 && (
            <details>
              <summary>Horário de funcionamento</summary>
              <ul>{store.hours.map((h, i) => <li key={i}>{h.day}: {h.opensAt} às {h.closesAt}</li>)}</ul>
            </details>
          )}
        </footer>
      </main>

      {cart.count > 0 && (
        <div className="cart-bar">
          <button className="btn btn-primary btn-block cart-bar-btn" onClick={() => setCartOpen(true)}>
            <span className="cart-count">{cart.count}</span>
            <span>Ver carrinho</span>
            <span>{brl(cart.subtotalCents)}</span>
          </button>
        </div>
      )}

      {product && <ProductSheet product={product} onClose={() => setProduct(null)} canOrder={store.open} />}
      {cartOpen && <CartSheet store={store} onClose={() => setCartOpen(false)} onCheckout={() => navigate('/cardapio/checkout')} />}
    </div>
  );
}
