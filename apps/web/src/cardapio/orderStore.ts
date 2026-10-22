import { api, storage } from '../lib/api';

// Pedidos feitos neste aparelho (só o token de acompanhamento fica guardado; os dados vêm do servidor).
export const ORDERS_KEY = 'rangasso.orders.v1';
export interface MyOrderRef { token: string; number: number; at: string }

export const myOrders = () => storage.get<MyOrderRef[]>(ORDERS_KEY, []).filter((o) => o && typeof o.token === 'string');

export function rememberOrder(o: MyOrderRef) {
  storage.set(ORDERS_KEY, [o, ...myOrders().filter((x) => x.token !== o.token)].slice(0, 20));
}

export function forgetOrder(token: string) {
  storage.set(ORDERS_KEY, myOrders().filter((x) => x.token !== token));
}

export interface PublicOrder {
  number: number; status: string; statusLabel: string; createdAt: string; customerName: string; address: string;
  items: { quantity: number; name: string; lineTotalCents: number; notes: string; addons: string[] }[];
  subtotalCents: number; deliveryFeeCents: number; deliveryFeePending?: boolean; deliveryDistanceKm?: number | null; discountCents: number; totalCents: number; payment: string;
  changeForCents: number | null; cancelReason: string | null;
  canReview?: boolean;
  review?: { rating: number; comment: string; photoUrl: string | null; createdAt: string } | null;
}

export async function fetchOrder(token: string, signal?: AbortSignal) {
  return api<PublicOrder>(`/api/public/orders/${token}`, { signal });
}

export const isActive = (status: string) => status !== 'completed' && status !== 'cancelled';

// ---- Avisos no celular (Web Push) ----
const PUSH_KEY = 'rangasso.push.v1';

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
// iPhone/iPad fora da Tela de Início: o Safari só libera avisos para o app adicionado à Tela de Início.
export const iosNeedsHomeScreen = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator as any).standalone && !window.matchMedia('(display-mode: standalone)').matches;
export const pushEnabledFor = (token: string) => storage.get<string[]>(PUSH_KEY, []).includes(token);

function urlBase64ToUint8Array(base64: string) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function enablePush(token: string) {
  if (!pushSupported()) throw new Error('Este navegador não recebe avisos.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Permissão de avisos negada. Libere as notificações do site nas configurações do navegador.');
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const { publicKey } = await api<{ publicKey: string }>('/api/public/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  await api(`/api/public/orders/${token}/push`, { body: sub.toJSON() });
  storage.set(PUSH_KEY, [token, ...storage.get<string[]>(PUSH_KEY, []).filter((t) => t !== token)].slice(0, 20));
}
