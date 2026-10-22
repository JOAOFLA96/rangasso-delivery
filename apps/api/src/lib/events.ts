import { EventEmitter } from 'node:events';

// Barramento em memória para tempo real (SSE do painel e long-poll do agente).
// O sistema roda em uma instância; para várias instâncias, trocar por LISTEN/NOTIFY do Postgres.
export type StoreEvent =
  | { type: 'order.created'; orderId: string; number: number }
  | { type: 'order.updated'; orderId: string; number: number }
  | { type: 'print.updated'; jobId: string; orderId: string | null }
  | { type: 'print.queued'; jobId: string }
  | { type: 'agent.updated'; deviceId: string }
  | { type: 'review.created'; orderId: string };

const bus = new EventEmitter();
bus.setMaxListeners(1000);

export const emitStoreEvent = (storeId: string, ev: StoreEvent) => bus.emit(`store:${storeId}`, ev);

export function onStoreEvent(storeId: string, fn: (ev: StoreEvent) => void) {
  bus.on(`store:${storeId}`, fn);
  return () => bus.off(`store:${storeId}`, fn);
}
