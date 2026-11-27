import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, brl, formatTime } from '../lib/api';
import './motoboy.css';

// Página do motoboy no celular: a saída dele na ordem certa, o que cobrar em cada casa, atalhos para navegar e falar com o
// cliente, e a baixa de cada entrega. Atualiza sozinha a cada 20 s (a loja pode mexer na saída antes dele sair).

const PAY = { cash: 'Dinheiro', pix: 'Pix', card: 'Cartão (maquininha)' } as const;
interface Stop {
  orderId: string; number: number; status: string; position: number; customerName: string; customerPhone: string; street: string; streetNumber: string;
  complement: string; reference: string; neighborhood: string; paymentMethod: keyof typeof PAY; changeForCents: number | null; totalCents: number;
  etaOffsetS: number | null; outcome: 'delivered' | 'not_delivered' | null; outcomeNote: string; outcomeAt: string | null; address: string;
  lat: number | null; lng: number | null; arrivingAt: string | null; orderCreatedAt: string;
}
interface Run { id: string; number: number; status: 'planned' | 'out'; departedAt: string | null; totalDistanceM: number | null; totalDurationS: number | null; mapsUrl: string | null; stops: Stop[] }
interface Page {
  courier: { name: string }; store: { name: string; phone: string }; runs: Run[]; reasons: string[];
  today: { delivered: number; not_delivered: number; cash_cents: number; card_cents: number; pix_cents: number; fees_cents: number; runs: number };
}

const fmtPhone = (d: string) => (d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d);
const minutesSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
const wazeUrl = (s: Stop) => (s.lat != null && s.lng != null ? `https://waze.com/ul?ll=${s.lat},${s.lng}&navigate=yes` : `https://waze.com/ul?q=${encodeURIComponent(s.address)}&navigate=yes`);
const mapsUrl = (s: Stop) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(s.lat != null ? `${s.lat},${s.lng}` : s.address)}&travelmode=driving`;
const waUrl = (s: Stop, courier: string, store: string) =>
  `https://wa.me/55${s.customerPhone}?text=${encodeURIComponent(`Olá, ${s.customerName.split(' ')[0]}! Aqui é ${courier}, do ${store}. Estou chegando com seu pedido #${s.number} 🛵`)}`;

function charge(s: Stop) {
  if (s.paymentMethod === 'cash') {
    const change = s.changeForCents && s.changeForCents > s.totalCents ? s.changeForCents - s.totalCents : 0;
    return { label: `Cobrar ${brl(s.totalCents)} em dinheiro`, extra: change ? `Cliente paga com ${brl(s.changeForCents)}: levar ${brl(change)} de troco` : 'Sem troco informado' };
  }
  if (s.paymentMethod === 'card') return { label: `Cobrar ${brl(s.totalCents)} na maquininha`, extra: '' };
  return { label: `Pix: ${brl(s.totalCents)}`, extra: 'Confira com a loja se o Pix já foi pago' };
}

const TOKEN_KEY = 'rangasso.motoboy';
const saveToken = (t: string) => { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* navegador sem armazenamento */ } };
const savedToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const UUID_IN_URL = /\/motoboy\/pegar\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

// QR do cupom lido com a câmera normal do celular: abre /motoboy/pegar/<pedido> e volta para a página do motoboy deste aparelho.
export function PegarPedido() {
  const { orderId } = useParams();
  const token = savedToken();
  if (token && orderId) return <Navigate to={`/motoboy/${token}?pegar=${orderId}`} replace />;
  return (
    <main className="mb">
      <section className="mb-card mb-center">
        <p className="mb-big">Abra primeiro o seu link de motoboy</p>
        <p className="mb-muted">É o link que a loja mandou no seu WhatsApp. Abra ele neste celular uma vez e depois leia o QR do cupom de novo.</p>
      </section>
    </main>
  );
}

// Leitor de QR dentro da página (Android/Chrome). Onde o navegador não lê QR, o motoboy usa a câmera do celular ou digita o número.
const canScan = () => typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
function Scanner({ onCode, onClose }: { onCode: (orderId: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stop) return;
        video.current!.srcObject = stream;
        await video.current!.play();
        const detector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
        while (!stop) {
          const codes = await detector.detect(video.current!).catch(() => []);
          const m = codes.map((c: any) => String(c.rawValue).match(UUID_IN_URL)).find(Boolean);
          if (m) { onCode(m[1]); return; }
          if (codes.length) setErr('Esse QR não é de um pedido da loja.');
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch {
        setErr('Não consegui abrir a câmera. Libere a câmera para este site ou digite o número do pedido.');
      }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [onCode]);
  return (
    <div className="mb-sheet" role="dialog" aria-label="Ler QR do cupom">
      <div className="mb-sheet-body">
        <strong>Aponte para o QR do cupom</strong>
        <video ref={video} className="mb-video" muted playsInline />
        {err && <p className="mb-error-text">{err}</p>}
        <button className="mb-btn mb-ghost" onClick={onClose}>Fechar</button>
      </div>
    </div>
  );
}

// Rastreio durante a saída: o celular manda a posição para a loja (no máximo a cada 20 s) e mantém a tela acesa.
// Para sozinho quando a saída termina ou o servidor recusa. No navegador, para também se a página fechar ou o celular travar a tela.
type Track = 'off' | 'on' | 'denied' | 'unsupported';
function useTracking(token: string | undefined, active: boolean): Track {
  const [state, setState] = useState<Track>('off');
  useEffect(() => {
    if (!active || !token) { setState('off'); return; }
    if (!('geolocation' in navigator)) { setState('unsupported'); return; }
    let last = 0;
    let stopped = false;
    let lock: any = null;
    const keepAwake = async () => { try { lock = await (navigator as any).wakeLock?.request('screen'); } catch { /* sem suporte */ } };
    keepAwake();
    const onVis = () => document.visibilityState === 'visible' && keepAwake();
    document.addEventListener('visibilitychange', onVis);
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setState('on');
        if (stopped || Date.now() - last < 20_000) return;
        last = Date.now();
        api(`/api/courier/${token}/location`, { method: 'POST', body: { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy } })
          .catch((e) => { if (e instanceof ApiError && e.code === 'not_out') stopped = true; });
      },
      (e) => setState(e.code === e.PERMISSION_DENIED ? 'denied' : 'on'),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
    return () => { navigator.geolocation.clearWatch(id); document.removeEventListener('visibilitychange', onVis); lock?.release?.().catch?.(() => undefined); };
  }, [token, active]);
  return state;
}

export default function MotoboyApp() {
  const { token } = useParams();
  const [params, setParams] = useSearchParams();
  const [scan, setScan] = useState(false);
  const [num, setNum] = useState('');
  const [swap, setSwap] = useState<{ ref: { orderId?: string; number?: number }; message: string } | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [isOut, setIsOut] = useState(false);
  const track = useTracking(token, isOut);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fail, setFail] = useState<Stop | null>(null);
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    try {
      const p = await api<Page>(`/api/courier/${token}`);
      setPage(p);
      setIsOut(p.runs.some((r) => r.status === 'out'));
      if (token) saveToken(token);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [token]);
  useEffect(() => {
    document.title = 'Minhas entregas — Rangasso';
    load();
    const t = setInterval(() => { load(); tick((n) => n + 1); }, 20_000);
    const onVis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

  async function act(key: string, path: string, body?: unknown) {
    setBusy(key);
    try {
      await api(`/api/courier/${token}${path}`, { method: 'POST', body: body ?? {} });
      await load();
    } catch (e) {
      alertBox((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const [msg, setMsg] = useState<string | null>(null);
  const alertBox = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 6000); };

  // Pegar pedido pelo QR do cupom (ou número): entra na saída dele e a rota é refeita no servidor.
  const claim = useCallback(async (ref: { orderId?: string; number?: number }, confirm = false) => {
    setBusy('claim');
    setSwap(null);
    try {
      const r = await api<{ number: number; already: boolean; from: string | null }>(`/api/courier/${token}/claim`, { method: 'POST', body: { ...ref, confirm } });
      const m = r.already ? `O pedido #${r.number} já está com você.` : `Pedido #${r.number} entrou na sua saída${r.from ? ` (estava com ${r.from})` : ''}. Rota refeita.`;
      setOkMsg(m);
      setTimeout(() => setOkMsg(null), 6000);
      setNum('');
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_swap') setSwap({ ref, message: e.message });
      else alertBox((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [token, load]);
  const fromQr = params.get('pegar');
  useEffect(() => {
    if (!fromQr) return;
    setParams({}, { replace: true });
    if (/^[0-9a-f-]{36}$/i.test(fromQr)) claim({ orderId: fromQr });
  }, [fromQr, claim, setParams]);
  const onScan = useCallback((orderId: string) => { setScan(false); claim({ orderId }); }, [claim]);

  if (error && !page) return <main className="mb"><div className="mb-card mb-error">{error.includes('não encontrado') ? 'Link inválido ou desativado. Peça um link novo para a loja.' : error}</div></main>;
  if (!page) return <main className="mb"><p className="mb-muted">Carregando…</p></main>;
  const run = page.runs.find((r) => r.status === 'out') ?? page.runs[page.runs.length - 1];
  const nextRun = run?.status === 'out' ? page.runs.find((r) => r.status === 'planned') : undefined;
  const open = run ? run.stops.filter((s) => !s.outcome && s.status !== 'cancelled') : [];
  const next = run?.status === 'out' ? open[0] : undefined;
  const cashToCollect = open.filter((s) => s.paymentMethod === 'cash').reduce((a, s) => a + s.totalCents, 0);
  const changeToBring = open.reduce((a, s) => a + (s.paymentMethod === 'cash' && s.changeForCents && s.changeForCents > s.totalCents ? s.changeForCents - s.totalCents : 0), 0);

  return (
    <main className="mb">
      <header className="mb-head">
        <img src="/brand/logo-rangasso-trim.png" alt={page.store.name} />
        <div><strong>Olá, {page.courier.name}</strong><span className="mb-muted">Minhas entregas</span></div>
      </header>
      {msg && <div className="mb-card mb-error" role="alert">{msg}</div>}
      {okMsg && <div className="mb-card mb-success" role="status">{okMsg}</div>}

      <section className="mb-card mb-claim">
        <strong>Pegou pedido no balcão?</strong>
        {canScan()
          ? <button className="mb-btn mb-primary" disabled={busy === 'claim'} onClick={() => setScan(true)}>📷 Ler QR do cupom</button>
          : <p className="mb-muted small">Leia o QR do cupom com a câmera do celular, ou digite o número do pedido.</p>}
        <form className="mb-claim-row" onSubmit={(e) => { e.preventDefault(); const n = Number(num.replace(/\D/g, '')); if (n) claim({ number: n }); }}>
          <input inputMode="numeric" aria-label="Número do pedido" placeholder="Nº do pedido" value={num} onChange={(e) => setNum(e.target.value.replace(/\D/g, '').slice(0, 8))} />
          <button className="mb-btn mb-secondary" disabled={!num || busy === 'claim'}>Pegar</button>
        </form>
      </section>

      {!run && (
        <section className="mb-card mb-center">
          <p className="mb-big">Nenhuma entrega para você agora.</p>
          <p className="mb-muted">Quando a loja separar pedidos para você, eles aparecem aqui sozinhos.</p>
        </section>
      )}

      {run && (
        <>
          <section className={`mb-card mb-run ${run.status}`}>
            <div className="mb-row">
              <strong>Saída #{run.number}</strong>
              <span className={`mb-pill ${run.status}`}>{run.status === 'out' ? `Na rua desde ${formatTime(run.departedAt!)}` : 'Esperando sair'}</span>
            </div>
            <p>{run.stops.length} entrega(s){run.totalDistanceM ? ` · ${(run.totalDistanceM / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km ida e volta` : ''}{run.totalDurationS ? ` · ~${Math.round(run.totalDurationS / 60)} min de direção` : ''}</p>
            {(cashToCollect > 0 || changeToBring > 0) && (
              <p className="mb-money">💵 Dinheiro a cobrar: <strong>{brl(cashToCollect)}</strong>{changeToBring ? <> · leve <strong>{brl(changeToBring)}</strong> de troco</> : null}</p>
            )}
            {run.status === 'out' && (
              <p className={`mb-track ${track}`}>
                {track === 'denied' ? '📍 Localização bloqueada: a loja não vê onde você está. Libere a localização deste site nas configurações do navegador.'
                  : track === 'unsupported' ? '📍 Este navegador não envia localização.'
                  : '📍 Enquanto você está na rua, sua localização vai para a loja. Para quando você voltar. Deixe esta página aberta.'}
              </p>
            )}
            {run.status === 'planned' && <p className="mb-muted small">Ao sair, a loja passa a ver sua localização no mapa até você voltar (o celular vai pedir permissão).</p>}
            {run.mapsUrl && <a className="mb-btn mb-secondary" href={run.mapsUrl} target="_blank" rel="noreferrer">🗺️ Rota completa no Google Maps</a>}
            {run.status === 'planned' && (
              <button className="mb-btn mb-primary" disabled={busy === 'depart'} onClick={() => act('depart', `/runs/${run.id}/depart`)}>
                {busy === 'depart' ? 'Registrando…' : '🛵 Peguei os pedidos, estou saindo'}
              </button>
            )}
            {run.status === 'planned' && <p className="mb-muted small">Confira se todas as marmitas e bebidas estão na bag antes de sair. Ao sair, os clientes recebem o aviso.</p>}
          </section>
          {nextRun && <p className="mb-card mb-muted small">Próxima saída já separada: #{nextRun.number} com {nextRun.stops.length} pedido(s). Aparece aqui quando você voltar.</p>}

          <ol className="mb-stops">
            {run.stops.map((s) => {
              const c = charge(s);
              const wait = minutesSince(s.orderCreatedAt);
              const isNext = next?.orderId === s.orderId;
              return (
                <li key={s.orderId} className={`mb-card mb-stop ${s.outcome ?? ''} ${isNext ? 'next' : ''} ${s.status === 'cancelled' ? 'cancelled' : ''}`}>
                  <div className="mb-row">
                    <span className="mb-pos">{s.position}</span>
                    <strong className="mb-grow">Pedido #{s.number} · {s.customerName.split(' ')[0]}</strong>
                    {!s.outcome && s.status !== 'cancelled' && <span className={`mb-wait ${wait >= 60 ? 'late' : wait >= 40 ? 'warn' : ''}`} title="Tempo desde o pedido">⏱ {wait} min</span>}
                  </div>
                  {isNext && <p className="mb-next">➡️ Próxima entrega</p>}
                  <p className="mb-addr">{s.street}, {s.streetNumber}{s.complement ? ` – ${s.complement}` : ''}<br /><span className="mb-muted">{s.neighborhood}</span></p>
                  {s.reference && <p className="mb-ref">Ref.: {s.reference}</p>}
                  {s.status === 'cancelled' && <p className="mb-error-text">Pedido cancelado: devolva na loja.</p>}
                  {s.outcome === 'delivered' && <p className="mb-ok">✅ Entregue às {formatTime(s.outcomeAt!)}</p>}
                  {s.outcome === 'not_delivered' && <p className="mb-error-text">↩️ Não entregue: {s.outcomeNote}. Traga de volta para a loja.</p>}
                  {!s.outcome && s.status !== 'cancelled' && (
                    <>
                      <p className="mb-charge"><strong>{c.label}</strong>{c.extra && <><br /><span>{c.extra}</span></>}</p>
                      <div className="mb-links">
                        <a className="mb-btn mb-secondary" href={wazeUrl(s)} target="_blank" rel="noreferrer">Waze</a>
                        <a className="mb-btn mb-secondary" href={mapsUrl(s)} target="_blank" rel="noreferrer">Maps</a>
                        <a className="mb-btn mb-secondary" href={`tel:${s.customerPhone}`}>📞 Ligar</a>
                        <a className="mb-btn mb-secondary" href={waUrl(s, page.courier.name, page.store.name)} target="_blank" rel="noreferrer">WhatsApp</a>
                      </div>
                      {run.status === 'out' && (
                        <>
                          {s.arrivingAt
                            ? <p className="mb-muted small">Cliente avisado que você está chegando ({formatTime(s.arrivingAt)}).</p>
                            : <button className="mb-btn mb-secondary" disabled={busy === `a-${s.orderId}`} onClick={() => act(`a-${s.orderId}`, `/runs/${run.id}/stops/${s.orderId}/arriving`)}>🔔 Avisar cliente que estou chegando</button>}
                          <div className="mb-links two">
                            <button className="mb-btn mb-primary" disabled={busy === `d-${s.orderId}`} onClick={() => act(`d-${s.orderId}`, `/runs/${run.id}/stops/${s.orderId}`, { outcome: 'delivered' })}>✅ Entreguei</button>
                            <button className="mb-btn mb-secondary" onClick={() => setFail(s)}>Não consegui</button>
                          </div>
                        </>
                      )}
                      <p className="mb-muted small">📞 {fmtPhone(s.customerPhone)}</p>
                    </>
                  )}
                  {s.status === 'cancelled' && !s.outcome && run.status === 'out' && (
                    <button className="mb-btn mb-secondary" onClick={() => act(`d-${s.orderId}`, `/runs/${run.id}/stops/${s.orderId}`, { outcome: 'not_delivered', note: 'Pedido cancelado' })}>Ok, vou devolver</button>
                  )}
                </li>
              );
            })}
          </ol>

          {run.status === 'out' && (
            <section className="mb-card">
              <button className="mb-btn mb-primary" disabled={open.length > 0 || busy === 'finish'} onClick={() => act('finish', `/runs/${run.id}/finish`)}>🏠 Voltei para a loja</button>
              {open.length > 0 && <p className="mb-muted small">Dê baixa em todas as entregas antes de fechar a saída.</p>}
            </section>
          )}
        </>
      )}

      <section className="mb-card mb-today">
        <strong>Hoje</strong>
        <div className="mb-grid">
          <span>Entregas<b>{page.today.delivered}</b></span>
          <span>Saídas<b>{page.today.runs}</b></span>
          <span>Não entregues<b>{page.today.not_delivered}</b></span>
          <span>Taxas de entrega<b>{brl(page.today.fees_cents)}</b></span>
        </div>
        <p>💵 Dinheiro recebido para acertar com a loja: <strong>{brl(page.today.cash_cents)}</strong></p>
        <p className="mb-muted small">Cartão: {brl(page.today.card_cents)} · Pix: {brl(page.today.pix_cents)}. O troco já está descontado: o valor é o total dos pedidos pagos em dinheiro.</p>
      </section>
      {page.store.phone && <p className="mb-center mb-muted">Dúvida? Ligue para a loja: <a href={`tel:${page.store.phone.replace(/\D/g, '')}`}>{page.store.phone}</a></p>}

      {fail && (
        <div className="mb-sheet" role="dialog" aria-label="Motivo da não entrega" onClick={() => setFail(null)}>
          <div className="mb-sheet-body" onClick={(e) => e.stopPropagation()}>
            <strong>Pedido #{fail.number}: por que não entregou?</strong>
            {page.reasons.map((r) => (
              <button key={r} className="mb-btn mb-secondary" onClick={() => { const s = fail; setFail(null); act(`d-${s.orderId}`, `/runs/${run!.id}/stops/${s.orderId}`, { outcome: 'not_delivered', note: r }); }}>{r}</button>
            ))}
            <button className="mb-btn mb-ghost" onClick={() => setFail(null)}>Voltar</button>
          </div>
        </div>
      )}
      {scan && <Scanner onCode={onScan} onClose={() => setScan(false)} />}
      {swap && (
        <div className="mb-sheet" role="dialog" aria-label="Trocar pedido de motoboy" onClick={() => setSwap(null)}>
          <div className="mb-sheet-body" onClick={(e) => e.stopPropagation()}>
            <strong>{swap.message}</strong>
            <p className="mb-muted small">Só confirme se a marmita está mesmo na sua mão. O outro motoboy deixa de ver esse pedido.</p>
            <button className="mb-btn mb-primary" disabled={busy === 'claim'} onClick={() => claim(swap.ref, true)}>Sim, pegar para mim</button>
            <button className="mb-btn mb-ghost" onClick={() => setSwap(null)}>Não</button>
          </div>
        </div>
      )}
    </main>
  );
}
