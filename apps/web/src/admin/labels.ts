export const STATUS = {
  received: { label: 'Recebido', cls: 's-received' },
  confirmed: { label: 'Confirmado', cls: 's-confirmed' },
  preparing: { label: 'Em preparo', cls: 's-preparing' },
  out_for_delivery: { label: 'Saiu para entrega', cls: 's-out' },
  completed: { label: 'Concluído', cls: 's-done' },
  cancelled: { label: 'Cancelado', cls: 's-cancelled' },
} as const;
export type Status = keyof typeof STATUS;

// Pedido para retirar: a etapa "saiu para entrega" vira "pronto para retirar".
export const statusLabel = (status: Status, fulfillment?: string) =>
  fulfillment === 'pickup' && status === 'out_for_delivery' ? 'Pronto para retirar' : fulfillment === 'pickup' && status === 'completed' ? 'Retirado' : STATUS[status].label;

export function nextAction(status: Status, fulfillment?: string) {
  const n = NEXT_ACTION[status];
  if (n && fulfillment === 'pickup' && n.to === 'out_for_delivery') return { ...n, label: 'Pronto para retirar' };
  if (n && fulfillment === 'pickup' && n.to === 'completed') return { ...n, label: 'Cliente retirou' };
  return n;
}

export const NEXT_ACTION: Partial<Record<Status, { to: Status; label: string }>> = {
  received: { to: 'confirmed', label: 'Confirmar pedido' },
  confirmed: { to: 'preparing', label: 'Iniciar preparo' },
  preparing: { to: 'out_for_delivery', label: 'Saiu para entrega' },
  out_for_delivery: { to: 'completed', label: 'Concluir' },
};

export const PRINT = {
  not_queued: { label: 'Aguardando impressão', cls: 'p-wait' },
  pending: { label: 'Na fila', cls: 'p-queue' },
  claimed: { label: 'Recebido pelo agente', cls: 'p-queue' },
  sending: { label: 'Enviando à impressora', cls: 'p-queue' },
  sent: { label: 'Enviado à impressora', cls: 'p-sent' },
  printed: { label: 'Impresso', cls: 'p-ok' },
  failed: { label: 'Falha na impressão', cls: 'p-fail' },
  uncertain: { label: 'Resultado incerto', cls: 'p-fail' },
  cancelled: { label: 'Impressão cancelada', cls: 'p-wait' },
} as const;
export type PrintStatus = keyof typeof PRINT;

export const PAYMENT = { cash: 'Dinheiro', pix: 'Pix', card: 'Cartão na entrega' } as const;

export const PRINT_HELP: Partial<Record<PrintStatus, string>> = {
  sent: 'O Windows aceitou a comanda, mas a impressora USB não confirma a impressão física. Confira no balcão.',
  uncertain: 'O agente perdeu contato durante o envio. Confira se a comanda saiu antes de reimprimir, para não duplicar.',
  failed: 'A impressão falhou. O sistema tenta de novo sozinho em intervalos crescentes; veja o erro abaixo.',
};

export const fmtPhone = (d: string) =>
  d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : d;
