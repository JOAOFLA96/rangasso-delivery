import { useEffect, useRef, useState } from 'react';

export type LiveState = 'connecting' | 'live' | 'reconnecting';

// Conexão SSE do painel. O navegador reconecta sozinho; a cada (re)conexão chamamos onSync para recarregar
// tudo e não perder eventos que ocorreram enquanto a conexão estava fora.
export function useLiveEvents(onEvent: (type: string, data: any) => void, onSync: () => void) {
  const [state, setState] = useState<LiveState>('connecting');
  const ev = useRef(onEvent);
  const sync = useRef(onSync);
  ev.current = onEvent;
  sync.current = onSync;

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const types = ['order.created', 'order.updated', 'print.updated', 'print.queued', 'agent.updated'];

    function connect() {
      es = new EventSource('/api/admin/events');
      es.addEventListener('hello', () => {
        setState('live');
        sync.current();
      });
      for (const t of types) es.addEventListener(t, (m) => ev.current(t, JSON.parse((m as MessageEvent).data)));
      es.onerror = () => {
        setState('reconnecting');
        if (es?.readyState === EventSource.CLOSED && !closed) {
          // Fechado de vez (ex.: servidor reiniciou com erro): tenta de novo manualmente.
          es.close();
          retry = setTimeout(connect, 5000);
        }
      };
    }
    connect();
    const onOnline = () => {
      if (es?.readyState !== EventSource.OPEN) {
        es?.close();
        connect();
      }
    };
    window.addEventListener('online', onOnline);
    return () => {
      closed = true;
      es?.close();
      if (retry) clearTimeout(retry);
      window.removeEventListener('online', onOnline);
    };
  }, []);
  return state;
}

// Alerta sonoro de pedido novo (precisa de um toque do usuário antes, por regra dos navegadores).
let ctx: AudioContext | null = null;
export function enableSound() {
  ctx ??= new AudioContext();
  return ctx.resume();
}
export function beep() {
  if (!ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  for (const [i, f] of [880, 1320, 880].entries()) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, now + i * 0.22);
    g.gain.exponentialRampToValueAtTime(0.3, now + i * 0.22 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.22 + 0.2);
    o.connect(g).connect(ctx.destination);
    o.start(now + i * 0.22);
    o.stop(now + i * 0.22 + 0.21);
  }
}
