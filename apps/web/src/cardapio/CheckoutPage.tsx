import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, brl, digits, maskCep, maskMoney, maskPhone, moneyToCents, newKey, normalize, storage } from '../lib/api';
import type { MenuData } from './CardapioApp';
import { useCart } from './cart';
import { CartLines } from './CartSheet';
import { StoreHeader } from './Header';

interface Quote { subtotalCents: number; deliveryFeeCents: number | null; deliveryFeePending?: boolean; discountCents: number; totalCents: number | null; promoSavingsCents: number; minOrderCents: number; belowMinimum: boolean }
interface SavedCustomer { name: string; phone: string; cep: string; street: string; number: string; neighborhoodId: string; neighborhoodName?: string; city?: string; complement: string; reference: string }

const SAVED_KEY = 'rangasso.customer.v1';
const ORDERS_KEY = 'rangasso.orders.v1';
// Valor do select para um bairro fora da lista (vem do CEP ou digitado); a taxa fica a combinar.
const NEW_HOOD = '__new__';

export function CheckoutPage({ data, reload }: { data: MenuData; reload: () => Promise<void> }) {
  const { store } = data;
  const cart = useCart();
  const navigate = useNavigate();
  const saved = useMemo(() => storage.get<SavedCustomer | null>(SAVED_KEY, null), []);

  const [form, setForm] = useState({
    name: saved?.name ?? '', phone: saved?.phone ?? '', cep: saved?.cep ?? '', street: saved?.street ?? '', number: saved?.number ?? '',
    neighborhoodId: saved?.neighborhoodId && store.neighborhoods.some((n) => n.id === saved.neighborhoodId)
      ? saved.neighborhoodId
      : saved?.neighborhoodName && store.acceptUnlistedNeighborhoods ? NEW_HOOD : '',
    neighborhoodName: saved?.neighborhoodName ?? '', city: saved?.city ?? '',
    complement: saved?.complement ?? '', reference: saved?.reference ?? '', notes: '',
    payment: '' as '' | 'cash' | 'pix' | 'card', needChange: false, changeFor: '', privacy: false, remember: true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<{ message: string; productId?: string } | null>(null);
  const [cepInfo, setCepInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Chave de idempotência: reaproveitada se o último envio teve resultado desconhecido (queda de rede) com os mesmos dados.
  const attempt = useRef<{ key: string; body: string; unknown: boolean } | null>(null);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: '' }));
  };

  const items = useMemo(() => cart.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, notes: l.notes, addonIds: l.addonIds })), [cart.lines]);

  const isNewHood = form.neighborhoodId === NEW_HOOD;
  const newHoodName = isNewHood ? form.neighborhoodName.trim() : '';

  useEffect(() => {
    if (!items.length) return;
    const ctrl = new AbortController();
    const hoodRef = isNewHood
      ? { neighborhoodId: null, neighborhoodName: newHoodName.length >= 2 ? newHoodName : null, city: form.city || null }
      : { neighborhoodId: form.neighborhoodId || null };
    api<Quote>('/api/public/quote', { body: { items, ...hoodRef }, signal: ctrl.signal })
      .then((q) => {
        setQuote(q);
        setQuoteError(null);
      })
      .catch((e) => {
        if (e.name === 'AbortError') return;
        setQuote(null);
        setQuoteError({ message: e.message, productId: e.details?.productId });
      });
    return () => ctrl.abort();
  }, [items, form.neighborhoodId, isNewHood, newHoodName, form.city]);

  // Busca de CEP no ViaCEP (serviço público): preenche rua e bairro. Bairro fora da lista entra com taxa a combinar
  // (se a loja aceitar); a loja define a taxa depois no painel.
  useEffect(() => {
    const cep = digits(form.cep);
    if (cep.length !== 8) {
      setCepInfo(null);
      return;
    }
    const ctrl = new AbortController();
    fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((r) => {
        if (r.erro) {
          setCepInfo('CEP não encontrado. Preencha o endereço manualmente.');
          return;
        }
        setForm((f) => ({ ...f, street: r.logradouro || f.street, city: r.localidade || f.city }));
        setErrors((e) => ({ ...e, street: r.logradouro ? '' : e.street, neighborhoodId: '', neighborhoodName: '' }));
        const match = store.neighborhoods.find((n) => normalize(n.name) === normalize(r.bairro ?? ''));
        if (match) {
          setForm((f) => ({ ...f, neighborhoodId: match.id, neighborhoodName: '' }));
          setCepInfo(null);
        } else if (r.bairro && store.acceptUnlistedNeighborhoods) {
          setForm((f) => ({ ...f, neighborhoodId: NEW_HOOD, neighborhoodName: r.bairro }));
          setCepInfo(null);
        } else if (r.bairro) {
          setCepInfo(`O CEP indica o bairro "${r.bairro}", que não está na nossa lista. Selecione seu bairro abaixo; se ele não aparecer, ainda não entregamos aí.`);
        } else {
          setCepInfo('Esse CEP não informa o bairro. Selecione ou digite o bairro abaixo.');
        }
      })
      .catch(() => setCepInfo(null));
    return () => ctrl.abort();
  }, [form.cep, store.neighborhoods, store.acceptUnlistedNeighborhoods]);

  if (!cart.lines.length) {
    return (
      <div className="c-shell">
        <StoreHeader store={store} compact />
        <div className="state-box">
          <p>Seu carrinho está vazio.</p>
          <Link className="btn btn-primary" to="/cardapio">Ver cardápio</Link>
        </div>
      </div>
    );
  }

  const enabledPayments = (['cash', 'pix', 'card'] as const).filter((m) => store.payments[m]);
  const labels = { cash: 'Dinheiro', pix: 'Pix', card: 'Cartão na entrega' };

  function validate() {
    const e: Record<string, string> = {};
    if (form.name.trim().length < 2) e.name = 'Informe seu nome.';
    const ph = digits(form.phone);
    if (!(ph.length === 10 || (ph.length === 11 && ph[2] === '9'))) e.phone = 'Telefone com DDD, ex.: (11) 98765-4321.';
    if (form.cep && digits(form.cep).length !== 8) e.cep = 'CEP com 8 dígitos.';
    if (form.street.trim().length < 2) e.street = 'Informe a rua.';
    if (!form.number.trim()) e.number = 'Informe o número (ou "s/n").';
    if (!form.neighborhoodId) e.neighborhoodId = 'Selecione o bairro.';
    else if (isNewHood && newHoodName.length < 2) e.neighborhoodName = 'Digite o nome do bairro.';
    if (!form.payment) e.payment = 'Escolha a forma de pagamento.';
    if (form.payment === 'cash' && form.needChange) {
      const c = moneyToCents(form.changeFor);
      if (!c) e.changeFor = 'Informe o valor para troco.';
      else if (quote?.totalCents != null && c < quote.totalCents) e.changeFor = `O valor precisa ser maior que o total (${brl(quote.totalCents)}).`;
    }
    if (!form.privacy) e.privacy = 'É preciso concordar para enviar o pedido.';
    setErrors(e);
    const first = Object.keys(e)[0];
    if (first) document.getElementById(`f-${first}`)?.focus();
    return !first;
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (submitting) return;
    setSubmitError(null);
    if (!validate()) return;
    const payload = {
      customer: { name: form.name.trim(), phone: form.phone },
      address: { cep: form.cep, street: form.street.trim(), number: form.number.trim(), ...(isNewHood ? { neighborhoodName: newHoodName, city: form.city } : { neighborhoodId: form.neighborhoodId }), complement: form.complement.trim(), reference: form.reference.trim() },
      notes: form.notes.trim(),
      payment: { method: form.payment, changeForCents: form.payment === 'cash' && form.needChange ? moneyToCents(form.changeFor) : null },
      items,
      acceptPrivacy: true,
    };
    const bodyStr = JSON.stringify(payload);
    const key = attempt.current?.unknown && attempt.current.body === bodyStr ? attempt.current.key : newKey();
    attempt.current = { key, body: bodyStr, unknown: true };
    setSubmitting(true);
    try {
      const res = await api<{ number: number; token: string }>('/api/public/orders', { body: { idempotencyKey: key, ...payload } });
      attempt.current = null;
      if (form.remember) {
        storage.set(SAVED_KEY, { name: form.name, phone: form.phone, cep: form.cep, street: form.street, number: form.number, neighborhoodId: isNewHood ? '' : form.neighborhoodId, neighborhoodName: isNewHood ? newHoodName : '', city: form.city, complement: form.complement, reference: form.reference });
      } else {
        storage.set(SAVED_KEY, null);
      }
      storage.set(ORDERS_KEY, [{ token: res.token, number: res.number, at: new Date().toISOString() }, ...storage.get<any[]>(ORDERS_KEY, [])].slice(0, 10));
      cart.clear();
      navigate(`/cardapio/pedido/${res.token}`, { replace: true });
    } catch (e) {
      const err = e as ApiError;
      if (err.code !== 'network' && err.status < 500) attempt.current = null; // recusado: nada foi criado
      if (err.code === 'idempotency_mismatch') attempt.current = null;
      if (err.code === 'store_closed') reload();
      const field = err.details?.field?.replace('customer.', '').replace('address.', '').replace(/^neighborhoodName$/, isNewHood ? 'neighborhoodName' : 'neighborhoodId').replace('payment.method', 'payment').replace('payment.changeForCents', 'changeFor');
      if (field) setErrors((x) => ({ ...x, [field]: err.message }));
      setSubmitError(err.code === 'network' ? 'A conexão caiu durante o envio. Toque em "Enviar pedido" de novo: se o pedido já tiver chegado, ele não será duplicado.' : err.message);
    } finally {
      setSubmitting(false);
    }
  }

  const hood = store.neighborhoods.find((n) => n.id === form.neighborhoodId);
  const hoodLabel = hood?.name ?? (newHoodName || null);
  const feePending = !!quote?.deliveryFeePending;
  const Err = ({ k }: { k: string }) => (errors[k] ? <span className="field-error" role="alert">{errors[k]}</span> : null);

  return (
    <div className="c-shell">
      <StoreHeader store={store} compact />
      <main className="c-main checkout">
        <Link to="/cardapio" className="back-link">← Voltar ao cardápio</Link>
        <h1>Finalizar pedido</h1>

        <form onSubmit={submit} noValidate>
          <section className="card">
            <h2>Seus dados</h2>
            <label className="field">
              <span>Nome</span>
              <input id="f-name" autoComplete="name" value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={80} aria-invalid={!!errors.name} />
              <Err k="name" />
            </label>
            <label className="field">
              <span>Telefone (WhatsApp)</span>
              <input id="f-phone" type="tel" inputMode="tel" autoComplete="tel-national" placeholder="(00) 00000-0000" value={form.phone} onChange={(e) => set('phone', maskPhone(e.target.value))} aria-invalid={!!errors.phone} />
              <Err k="phone" />
            </label>
          </section>

          <section className="card">
            <h2>Entrega</h2>
            <label className="field">
              <span>CEP <em className="muted">(opcional)</em></span>
              <input id="f-cep" inputMode="numeric" autoComplete="postal-code" placeholder="00000-000" value={form.cep} onChange={(e) => set('cep', maskCep(e.target.value))} aria-invalid={!!errors.cep} />
              <Err k="cep" />
              {cepInfo && <span className="hint">{cepInfo}</span>}
            </label>
            <label className="field">
              <span>Rua</span>
              <input id="f-street" autoComplete="address-line1" value={form.street} onChange={(e) => set('street', e.target.value)} maxLength={120} aria-invalid={!!errors.street} />
              <Err k="street" />
            </label>
            <div className="field-row">
              <label className="field">
                <span>Número</span>
                <input id="f-number" inputMode="text" value={form.number} onChange={(e) => set('number', e.target.value)} maxLength={15} aria-invalid={!!errors.number} />
                <Err k="number" />
              </label>
              <label className="field grow">
                <span>Complemento</span>
                <input id="f-complement" autoComplete="address-line2" placeholder="Apto, bloco…" value={form.complement} onChange={(e) => set('complement', e.target.value)} maxLength={80} />
              </label>
            </div>
            <label className="field">
              <span>Bairro</span>
              <select id="f-neighborhoodId" value={form.neighborhoodId} onChange={(e) => set('neighborhoodId', e.target.value)} aria-invalid={!!errors.neighborhoodId}>
                <option value="">Selecione o bairro</option>
                {store.neighborhoods.map((n) => (
                  <option key={n.id} value={n.id}>{n.name}{n.city ? ` (${n.city})` : ''} — {n.feePending ? 'taxa a combinar' : `taxa ${brl(n.feeCents)}`}</option>
                ))}
                {store.acceptUnlistedNeighborhoods && (
                  <option value={NEW_HOOD}>{isNewHood && newHoodName ? `${newHoodName} — taxa a combinar` : 'Outro bairro (digitar)'}</option>
                )}
              </select>
              <Err k="neighborhoodId" />
              {store.acceptUnlistedNeighborhoods ? (
                <span className="hint">Digite o CEP e o endereço é preenchido sozinho. Se o seu bairro não estiver na lista, a taxa de entrega é combinada com a loja.</span>
              ) : (
                <span className="hint">Seu bairro não está na lista? Ainda não entregamos aí{store.phone ? `. Dúvidas: ${store.phone}` : ''}.</span>
              )}
            </label>
            {isNewHood && (
              <label className="field">
                <span>Nome do bairro</span>
                <input id="f-neighborhoodName" value={form.neighborhoodName} onChange={(e) => set('neighborhoodName', e.target.value)} maxLength={80} aria-invalid={!!errors.neighborhoodName} />
                <Err k="neighborhoodName" />
              </label>
            )}
            <label className="field">
              <span>Ponto de referência <em className="muted">(opcional)</em></span>
              <input id="f-reference" value={form.reference} onChange={(e) => set('reference', e.target.value)} maxLength={120} />
            </label>
            {store.deliveryInstructions && <p className="hint">{store.deliveryInstructions}</p>}
          </section>

          <section className="card">
            <h2>Pagamento <span className="muted small">(na entrega)</span></h2>
            <div className="radio-list" id="f-payment" tabIndex={-1}>
              {enabledPayments.map((m) => (
                <label key={m} className={`radio-card ${form.payment === m ? 'checked' : ''}`}>
                  <input type="radio" name="payment" value={m} checked={form.payment === m} onChange={() => set('payment', m)} />
                  <span>{labels[m]}</span>
                </label>
              ))}
            </div>
            <Err k="payment" />
            {form.payment === 'pix' && store.payments.pixInstructions && <p className="hint">{store.payments.pixInstructions}</p>}
            {form.payment === 'cash' && (
              <div className="change-box">
                <label className="check">
                  <input type="checkbox" checked={form.needChange} onChange={(e) => set('needChange', e.target.checked)} />
                  <span>Preciso de troco</span>
                </label>
                {form.needChange && (
                  <label className="field">
                    <span>Troco para quanto?</span>
                    <input id="f-changeFor" inputMode="numeric" placeholder="R$ 0,00" value={form.changeFor} onChange={(e) => set('changeFor', maskMoney(e.target.value))} aria-invalid={!!errors.changeFor} />
                    <Err k="changeFor" />
                  </label>
                )}
              </div>
            )}
          </section>

          <section className="card">
            <h2>Resumo</h2>
            <CartLines editable={false} />
            <label className="field">
              <span>Observações do pedido <em className="muted">(opcional)</em></span>
              <textarea id="f-notes" rows={2} maxLength={300} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
            </label>
            {quoteError ? (
              <div className="alert alert-error">
                <p>{quoteError.message}</p>
                {quoteError.productId && (
                  <button type="button" className="btn btn-secondary" onClick={() => cart.removeProduct(quoteError.productId!)}>Remover este item</button>
                )}
              </div>
            ) : (
              <div className="totals">
                <div><span>Subtotal</span><span>{brl(quote?.subtotalCents)}</span></div>
                <div><span>Taxa de entrega{hoodLabel ? ` (${hoodLabel})` : ''}</span><span>{feePending ? 'a combinar' : quote?.deliveryFeeCents == null ? 'selecione o bairro' : brl(quote.deliveryFeeCents)}</span></div>
                {quote && quote.discountCents > 0 && <div><span>Desconto</span><span>− {brl(quote.discountCents)}</span></div>}
                {quote && quote.promoSavingsCents > 0 && <div className="muted small"><span>Você economizou com promoções</span><span>{brl(quote.promoSavingsCents)}</span></div>}
                <div className="total"><span>{feePending ? 'Total (sem a taxa)' : 'Total'}</span><strong>{quote?.totalCents == null ? '—' : brl(quote.totalCents)}</strong></div>
                {feePending && <p className="hint">A taxa de entrega do seu bairro ainda vai ser informada pela loja.</p>}
                {quote?.belowMinimum && <p className="alert alert-info">Pedido mínimo: {brl(quote.minOrderCents)}.</p>}
              </div>
            )}
          </section>

          <label className="check">
            <input id="f-privacy" type="checkbox" checked={form.privacy} onChange={(e) => set('privacy', e.target.checked)} />
            <span>Concordo com o uso dos meus dados para entrega deste pedido, conforme a <Link to="/cardapio/privacidade" target="_blank">política de privacidade</Link>.</span>
          </label>
          <Err k="privacy" />
          <label className="check">
            <input type="checkbox" checked={form.remember} onChange={(e) => set('remember', e.target.checked)} />
            <span>Lembrar meus dados neste aparelho</span>
          </label>

          {submitError && <div className="alert alert-error" role="alert">{submitError}</div>}

          <div className="checkout-submit">
            <button className="btn btn-primary btn-block btn-lg" type="submit" disabled={submitting || !store.open || !!quoteError || !!quote?.belowMinimum}>
              {submitting ? 'Enviando…' : !store.open ? 'Loja fechada' : `Enviar pedido${quote?.totalCents != null ? ` · ${brl(quote.totalCents)}` : ''}`}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
