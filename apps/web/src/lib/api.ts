// Cliente HTTP do frontend. Toda regra de preço/permissão é do servidor; aqui só exibição e validação amigável.

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-requested-with': 'rangasso' };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, credentials: 'same-origin', signal: opts.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'Sem conexão com o servidor. Verifique sua internet e tente novamente.');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(res.status, err?.code ?? 'http_' + res.status, err?.message ?? 'Erro inesperado. Tente novamente.', err?.details);
  }
  return data as T;
}

export const brl = (cents: number | null | undefined) =>
  cents == null ? '—' : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const digits = (s: string) => s.replace(/\D+/g, '');

export function maskPhone(v: string) {
  const d = digits(v).slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : '';
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

export function maskCep(v: string) {
  const d = digits(v).slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

// Campo de dinheiro: o usuário digita só números e o valor vai preenchendo os centavos.
export function maskMoney(v: string) {
  const d = digits(v).slice(0, 9);
  if (!d) return '';
  return brl(Number(d));
}
export const moneyToCents = (v: string) => (digits(v) ? Number(digits(v)) : null);

export const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
export function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function newKey() {
  return crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* armazenamento indisponível (modo privado): segue sem persistir */
    }
  },
};
