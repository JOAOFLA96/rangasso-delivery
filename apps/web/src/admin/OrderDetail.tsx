import { useEffect, useState } from 'react';
import { api, brl, formatDateTime } from '../lib/api';
import { NEXT_ACTION, PAYMENT, PRINT, PRINT_HELP, STATUS, fmtPhone, type Status, type PrintStatus } from './labels';
import { canManage, useSession } from './session';
import { Confirm, errorText, useToast } from './ui';

interface Detail {
  order: any;
  history: { from_status: Status | null; to_status: Status; note: string; created_at: string; user_name: string | null }[];
  printJobs: { id: string; kind: 'original' | 'reprint'; reprint_number: number; status: PrintStatus; attempts: number; max_attempts: number;
    next_attempt_at: string; last_error: string | null; reason: string; created_at: string; printed_at: string | null; requested_by_name: string | null; device_name: string | null }[];
}

export function OrderDetail({ id, version, onClose, onChanged }: { id: string; version: number; onClose: () => void; onChanged: () => void }) {
  const { user } = useSession();
  const toast = useToast();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | 'cancel' | 'reprint'>(null);

  useEffect(() => {
    let alive = true;
    api<Detail>(`/api/admin/orders/${id}`).then((r) => alive && (setD(r), setError(null))).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [id, version]);

  async function reload() {
    setD(await api<Detail>(`/api/admin/orders/${id}`));
    onChanged();
  }

  async function setStatus(status: Status, note = '') {
    setBusy(true);
    try {
      await api(`/api/admin/orders/${id}/status`, { body: { status, note } });
      toast(`Pedido #${d!.order.number}: ${STATUS[status].label}`);
      await reload();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function print(reason = '') {
    try {
      const r = await api<{ kind: string; reprintNumber: number }>(`/api/admin/orders/${id}/print`, { body: { reason } });
      toast(r.kind === 'reprint' ? `Reimpressão nº ${r.reprintNumber} enviada para a fila` : 'Comanda enviada para a fila');
      await reload();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  async function resolve(jobId: string, action: 'retry' | 'mark_printed' | 'cancel') {
    try {
      await api(`/api/admin/print-jobs/${jobId}/resolve`, { body: { action } });
      await reload();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  if (error) return <div className="a-detail"><button className="btn btn-ghost back-mobile" onClick={onClose}>← Voltar</button><div className="alert alert-error">{error}</div></div>;
  if (!d) return <div className="a-detail"><p className="muted pad">Carregando…</p></div>;

  const o = d.order;
  const next = NEXT_ACTION[o.status as Status];
  const final = o.status === 'completed' || o.status === 'cancelled';
  const address = `${o.street}, ${o.street_number}${o.complement ? ` - ${o.complement}` : ''} - ${o.neighborhood_name}${o.city ? `, ${o.city}` : ''}`;
  const changeBack = o.change_for_cents ? o.change_for_cents - o.total_cents : null;
  const ps = o.print_status as PrintStatus;

  return (
    <div className="a-detail">
      <div className="a-detail-head">
        <button className="btn btn-ghost back-mobile" onClick={onClose}>← Voltar</button>
        <div>
          <h2 className="a-detail-num">Pedido #{o.number}</h2>
          <p className="muted small">{formatDateTime(o.created_at)}</p>
        </div>
        <span className={`pill ${STATUS[o.status as Status].cls}`}>{STATUS[o.status as Status].label}</span>
      </div>

      {!final && (
        <div className="a-actions">
          {next && <button className="btn btn-primary btn-grow btn-lg" disabled={busy} onClick={() => setStatus(next.to)}>{next.label}</button>}
          {canManage(user) && <button className="btn btn-secondary" disabled={busy} onClick={() => setDialog('cancel')}>Cancelar</button>}
        </div>
      )}
      {o.status === 'cancelled' && <div className="alert alert-error">Cancelado: {o.cancel_reason}</div>}

      <section className="a-block">
        <h3>Cliente</h3>
        <p><strong>{o.customer_name}</strong></p>
        <p>
          <a href={`tel:${o.customer_phone}`}>{fmtPhone(o.customer_phone)}</a>
          {' · '}
          <a href={`https://wa.me/55${o.customer_phone}`} target="_blank" rel="noreferrer">WhatsApp</a>
        </p>
        <p>{address}{o.cep ? ` · CEP ${o.cep.slice(0, 5)}-${o.cep.slice(5)}` : ''}</p>
        {o.reference && <p className="muted">Referência: {o.reference}</p>}
        <p><a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`} target="_blank" rel="noreferrer">Abrir no mapa</a></p>
      </section>

      <section className="a-block">
        <h3>Itens</h3>
        <ul className="a-items">
          {o.items.map((i: any) => (
            <li key={i.id}>
              <div className="ai-line"><strong>{i.quantity}× {i.product_name}</strong><span>{brl(i.line_total_cents)}</span></div>
              {i.addons.length > 0 && <div className="muted small">+ {i.addons.map((a: any) => a.addon_name + (a.price_cents ? ` (${brl(a.price_cents)})` : '')).join(', ')}</div>}
              {i.unit_price_cents < i.regular_price_cents && <div className="muted small">Preço promocional: {brl(i.unit_price_cents)} (normal {brl(i.regular_price_cents)})</div>}
              {i.notes && <div className="note">Obs.: {i.notes}</div>}
            </li>
          ))}
        </ul>
        {o.notes && <div className="note">Observação do pedido: {o.notes}</div>}
        <div className="totals">
          <div><span>Subtotal</span><span>{brl(o.subtotal_cents)}</span></div>
          <div><span>Taxa de entrega</span><span>{brl(o.delivery_fee_cents)}</span></div>
          {o.discount_cents > 0 && <div><span>Desconto</span><span>− {brl(o.discount_cents)}</span></div>}
          <div className="total"><span>Total</span><strong>{brl(o.total_cents)}</strong></div>
        </div>
        <p><strong>Pagamento:</strong> {PAYMENT[o.payment_method as keyof typeof PAYMENT]}
          {o.change_for_cents ? ` · troco para ${brl(o.change_for_cents)} (levar ${brl(changeBack)})` : o.payment_method === 'cash' ? ' · sem troco' : ''}</p>
      </section>

      <section className="a-block">
        <div className="a-block-head">
          <h3>Impressão</h3>
          <span className={`pill ${PRINT[ps].cls}`}>{PRINT[ps].label}</span>
        </div>
        {PRINT_HELP[ps] && <p className="muted small">{PRINT_HELP[ps]}</p>}
        <button className="btn btn-secondary" onClick={() => (d.printJobs.some((j) => j.kind === 'original') ? setDialog('reprint') : print())}>
          {d.printJobs.some((j) => j.kind === 'original') ? 'Reimprimir comanda' : 'Imprimir comanda'}
        </button>
        {d.printJobs.length > 0 && (
          <ul className="a-jobs">
            {d.printJobs.map((j) => (
              <li key={j.id}>
                <div className="ai-line">
                  <span>{j.kind === 'original' ? 'Via original' : `Reimpressão nº ${j.reprint_number}`} · {formatDateTime(j.created_at)}</span>
                  <span className={`pill pill-sm ${PRINT[j.status].cls}`}>{PRINT[j.status].label}</span>
                </div>
                <div className="muted small">
                  {j.requested_by_name ? `Pedida por ${j.requested_by_name}. ` : ''}{j.reason ? `Motivo: ${j.reason}. ` : ''}
                  {j.attempts > 0 ? `Tentativas: ${j.attempts}/${j.max_attempts}. ` : ''}{j.device_name ? `Agente: ${j.device_name}.` : ''}
                </div>
                {j.last_error && j.status !== 'printed' && <div className="field-error">{j.last_error}</div>}
                {j.status === 'failed' && j.attempts < j.max_attempts && <div className="muted small">Próxima tentativa automática às {new Date(j.next_attempt_at).toLocaleTimeString('pt-BR')}.</div>}
                {(j.status === 'failed' || j.status === 'uncertain') && (
                  <div className="a-job-actions">
                    {j.status === 'uncertain' && <button className="btn btn-secondary btn-sm" onClick={() => resolve(j.id, 'mark_printed')}>Saiu, marcar como impresso</button>}
                    <button className="btn btn-secondary btn-sm" onClick={() => resolve(j.id, 'retry')}>{j.status === 'uncertain' ? 'Não saiu, imprimir de novo' : 'Tentar agora'}</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => resolve(j.id, 'cancel')}>Desistir</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="a-block">
        <h3>Histórico</h3>
        <ol className="a-history">
          {d.history.map((h, i) => (
            <li key={i}>
              <strong>{STATUS[h.to_status].label}</strong> · {formatDateTime(h.created_at)} · {h.user_name ?? 'Cliente (cardápio)'}
              {h.note && <div className="muted small">{h.note}</div>}
            </li>
          ))}
        </ol>
      </section>

      {dialog === 'cancel' && (
        <Confirm title={`Cancelar pedido #${o.number}?`} text="O pedido continua no histórico como cancelado, e o estoque dos produtos controlados é devolvido. Esta ação não pode ser desfeita."
          confirmLabel="Cancelar pedido" danger requireReason="Motivo do cancelamento" onClose={() => setDialog(null)} onConfirm={(r) => setStatus('cancelled', r)} />
      )}
      {dialog === 'reprint' && (
        <Confirm title="Reimprimir comanda?" text="A nova via sai marcada como REIMPRESSÃO. Informe o motivo, se quiser."
          confirmLabel="Reimprimir" requireReason="Motivo (opcional)" reasonOptional onClose={() => setDialog(null)} onConfirm={(r) => print(r)} />
      )}
    </div>
  );
}
