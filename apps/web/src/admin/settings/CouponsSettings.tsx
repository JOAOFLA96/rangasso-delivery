import { useEffect, useState } from 'react';
import { api, brl, formatDateTime } from '../../lib/api';
import { canManage, useSession } from '../session';
import { Confirm, Modal, Toggle, errorText, useToast } from '../ui';
import { centsToInput, inputToCents } from './useSettings';

type Kind = 'percent' | 'fixed' | 'free_delivery';
interface Coupon {
  id: string; code: string; description: string; kind: Kind; percent: number | null; amountCents: number | null; maxDiscountCents: number | null;
  minOrderCents: number; startsAt: string | null; endsAt: string | null; maxUses: number | null; maxUsesPerPhone: number | null;
  firstOrderOnly: boolean; active: boolean; label: string; status: 'active' | 'inactive' | 'expired' | 'scheduled' | 'exhausted';
  report: { uses: number; usesAllTime: number; customers: number; cancelled: number; lastUsedAt: string | null; discountTotalCents: number; revenueCents: number; subtotalCents: number; averageTicketCents: number };
}

const STATUS: Record<Coupon['status'], { label: string; cls: string }> = {
  active: { label: 'Valendo', cls: 's-done' },
  scheduled: { label: 'Agendado', cls: 's-confirmed' },
  expired: { label: 'Vencido', cls: 's-cancelled' },
  exhausted: { label: 'Esgotado', cls: 's-preparing' },
  inactive: { label: 'Desativado', cls: '' },
};
const KIND_LABEL: Record<Kind, string> = { percent: '% sobre os itens', fixed: 'Valor fixo (R$)', free_delivery: 'Entrega grátis' };

const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
const firstOfMonth = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('sv-SE'); };
const today = () => new Date().toLocaleDateString('sv-SE');

function rules(c: Coupon) {
  const r: string[] = [];
  if (c.minOrderCents) r.push(`pedido a partir de ${brl(c.minOrderCents)}`);
  if (c.maxUses) r.push(`${c.report.usesAllTime}/${c.maxUses} usos`);
  if (c.maxUsesPerPhone) r.push(c.maxUsesPerPhone === 1 ? '1 vez por cliente' : `${c.maxUsesPerPhone} vezes por cliente`);
  if (c.firstOrderOnly) r.push('só no 1º pedido');
  if (c.startsAt) r.push(`de ${formatDateTime(c.startsAt)}`);
  if (c.endsAt) r.push(`até ${formatDateTime(c.endsAt)}`);
  return r.join(' · ');
}

export function CouponsSettings() {
  const { user } = useSession();
  const manage = canManage(user);
  const toast = useToast();
  const [coupons, setCoupons] = useState<Coupon[] | null>(null);
  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(today);
  const [edit, setEdit] = useState<Partial<Coupon> | null>(null);
  const [remove, setRemove] = useState<Coupon | null>(null);

  const load = () => {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    return api<{ coupons: Coupon[] }>(`/api/admin/coupons?${qs}`).then((r) => setCoupons(r.coupons)).catch((e) => toast(errorText(e), 'error'));
  };
  useEffect(() => { load(); }, [from, to]);

  const tot = coupons?.reduce((a, c) => ({ uses: a.uses + c.report.uses, disc: a.disc + c.report.discountTotalCents, rev: a.rev + c.report.revenueCents }), { uses: 0, disc: 0, rev: 0 });

  return (
    <div>
      <div className="a-section-head">
        <h2>Cupons de desconto</h2>
        {manage && <button className="btn btn-primary btn-sm" onClick={() => setEdit({ kind: 'percent', active: true, maxUsesPerPhone: 1, minOrderCents: 0, firstOrderOnly: false })}>+ Cupom</button>}
      </div>
      <p className="muted small">
        O cliente digita o código ao finalizar o pedido. O sistema confere tudo sozinho: validade, pedido mínimo (só os itens, sem a taxa), limite de usos e
        limite por cliente (pelo telefone). A porcentagem e o valor fixo descontam dos itens; "entrega grátis" zera a taxa. Pedido cancelado devolve o uso.
      </p>

      <div className="a-filter-row" style={{ alignItems: 'end', margin: '10px 0' }}>
        <label className="field" style={{ margin: 0 }}><span>Relatório de</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field" style={{ margin: 0 }}><span>até</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="btn btn-secondary btn-sm" onClick={() => { setFrom(''); setTo(''); }}>Desde sempre</button>
      </div>

      {coupons === null ? <p className="muted">Carregando…</p> : !coupons.length ? (
        <p className="alert alert-info">Nenhum cupom cadastrado ainda.{manage ? ' Toque em "+ Cupom" para criar o primeiro.' : ''}</p>
      ) : (
        <div className="dl-table-wrap">
          <table className="a-table">
            <thead>
              <tr><th>Cupom</th><th>Desconto</th><th>Usos</th><th>Desconto dado</th><th>Faturamento</th><th>Ticket médio</th><th /></tr>
            </thead>
            <tbody>
              {coupons.map((c) => (
                <tr key={c.id} className={c.status === 'active' ? '' : 'inactive'}>
                  <td>
                    <strong>{c.code}</strong> <span className={`pill pill-sm ${STATUS[c.status].cls}`}>{STATUS[c.status].label}</span>
                    {c.description && <div className="muted small">{c.description}</div>}
                    {rules(c) && <div className="muted small">{rules(c)}</div>}
                  </td>
                  <td>{c.label}</td>
                  <td>{c.report.uses}{c.report.cancelled ? <div className="muted small">+{c.report.cancelled} cancelado(s)</div> : null}{c.report.lastUsedAt && <div className="muted small">último {formatDateTime(c.report.lastUsedAt)}</div>}</td>
                  <td>{brl(c.report.discountTotalCents)}</td>
                  <td>{brl(c.report.revenueCents)}</td>
                  <td>{c.report.uses ? brl(c.report.averageTicketCents) : '—'}</td>
                  <td>
                    {manage && (
                      <div className="a-actions">
                        <button className="btn btn-secondary btn-sm" onClick={() => setEdit(c)}>Editar</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setRemove(c)} aria-label={`Excluir ${c.code}`}>Excluir</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {tot && (
                <tr className="dl-total"><td>Total no período</td><td /><td>{tot.uses}</td><td>{brl(tot.disc)}</td><td>{brl(tot.rev)}</td><td>{tot.uses ? brl(Math.round(tot.rev / tot.uses)) : '—'}</td><td /></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">Faturamento = total pago pelos pedidos com o cupom (já com o desconto e a taxa). Pedidos cancelados não entram.</p>

      {edit && <CouponModal c={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
      {remove && (
        <Confirm
          title={`Excluir o cupom ${remove.code}?`}
          text={remove.report.usesAllTime ? 'O cupom para de funcionar e sai da lista. Os pedidos que já usaram continuam mostrando o código.' : 'O cupom para de funcionar e sai da lista.'}
          confirmLabel="Excluir" danger
          onClose={() => setRemove(null)}
          onConfirm={async () => {
            try {
              await api(`/api/admin/coupons/${remove.id}`, { method: 'DELETE' });
              toast('Cupom excluído');
              setRemove(null);
              load();
            } catch (e) { toast(errorText(e), 'error'); }
          }}
        />
      )}
    </div>
  );
}

function CouponModal({ c, onClose, onSaved }: { c: Partial<Coupon>; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    code: c.code ?? '', description: c.description ?? '', kind: (c.kind ?? 'percent') as Kind,
    percent: c.percent != null ? String(c.percent) : '', amount: centsToInput(c.amountCents), maxDiscount: centsToInput(c.maxDiscountCents),
    minOrder: c.minOrderCents ? centsToInput(c.minOrderCents) : '', startsAt: toLocalInput(c.startsAt), endsAt: toLocalInput(c.endsAt),
    maxUses: c.maxUses != null ? String(c.maxUses) : '', maxUsesPerPhone: c.maxUsesPerPhone != null ? String(c.maxUsesPerPhone) : '',
    firstOrderOnly: c.firstOrderOnly ?? false, active: c.active ?? true,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const int = (v: string) => (v.trim() ? Number(v) : null);

  async function save() {
    const amountCents = inputToCents(f.amount);
    const maxDiscountCents = inputToCents(f.maxDiscount);
    const minOrderCents = inputToCents(f.minOrder);
    if ([amountCents, maxDiscountCents, minOrderCents].some((n) => Number.isNaN(n))) return toast('Valor inválido. Use o formato 10,00.', 'error');
    const body = {
      code: f.code, description: f.description.trim(), kind: f.kind,
      percent: f.kind === 'percent' ? int(f.percent) : null,
      amountCents: f.kind === 'fixed' ? amountCents : null,
      maxDiscountCents: f.kind === 'percent' ? maxDiscountCents : null,
      minOrderCents: minOrderCents ?? 0,
      startsAt: fromLocalInput(f.startsAt), endsAt: fromLocalInput(f.endsAt),
      maxUses: int(f.maxUses), maxUsesPerPhone: int(f.maxUsesPerPhone), firstOrderOnly: f.firstOrderOnly, active: f.active,
    };
    setBusy(true);
    try {
      if (c.id) await api(`/api/admin/coupons/${c.id}`, { method: 'PUT', body });
      else await api('/api/admin/coupons', { body });
      toast('Cupom salvo');
      onSaved();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={c.id ? `Editar cupom ${c.code}` : 'Novo cupom'} onClose={onClose} footer={<button className="btn btn-primary btn-block" disabled={busy} onClick={save}>{busy ? 'Salvando…' : 'Salvar'}</button>}>
      <label className="field">
        <span>Código</span>
        <input value={f.code} maxLength={20} placeholder="Ex.: BEMVINDO10" onChange={(e) => set('code', e.target.value.toUpperCase().replace(/\s+/g, ''))} autoFocus={!c.id} />
        <span className="hint">De 3 a 20 letras ou números (sem espaço e sem acento). O cliente pode digitar com letra minúscula.{c.report?.usesAllTime ? ' Já foi usado: o código não pode mudar.' : ''}</span>
      </label>
      <label className="field"><span>Descrição interna (opcional)</span><input value={f.description} maxLength={120} placeholder="Ex.: Campanha Instagram novembro" onChange={(e) => set('description', e.target.value)} /></label>
      <label className="field">
        <span>Tipo de desconto</span>
        <select value={f.kind} onChange={(e) => set('kind', e.target.value as Kind)}>
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
      </label>
      {f.kind === 'percent' && (
        <div className="grid-2">
          <label className="field"><span>Porcentagem (%)</span><input inputMode="numeric" value={f.percent} onChange={(e) => set('percent', e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="10" /></label>
          <label className="field"><span>Desconto máximo em R$ (opcional)</span><input inputMode="decimal" value={f.maxDiscount} onChange={(e) => set('maxDiscount', e.target.value)} placeholder="20,00" /></label>
        </div>
      )}
      {f.kind === 'fixed' && (
        <label className="field"><span>Valor do desconto (R$)</span><input inputMode="decimal" value={f.amount} onChange={(e) => set('amount', e.target.value)} placeholder="10,00" /><span className="hint">Nunca passa do valor dos itens.</span></label>
      )}
      {f.kind === 'free_delivery' && <p className="hint">Zera a taxa de entrega. Não vale para retirada na loja nem quando a taxa do bairro está "a combinar".</p>}
      <label className="field"><span>Pedido mínimo em R$ (opcional)</span><input inputMode="decimal" value={f.minOrder} onChange={(e) => set('minOrder', e.target.value)} placeholder="sem mínimo" /><span className="hint">Conta só os itens (sem a taxa de entrega).</span></label>
      <div className="grid-2">
        <label className="field"><span>Começa em (opcional)</span><input type="datetime-local" value={f.startsAt} onChange={(e) => set('startsAt', e.target.value)} /></label>
        <label className="field"><span>Termina em (opcional)</span><input type="datetime-local" value={f.endsAt} onChange={(e) => set('endsAt', e.target.value)} /></label>
      </div>
      <div className="grid-2">
        <label className="field"><span>Limite total de usos (opcional)</span><input inputMode="numeric" value={f.maxUses} onChange={(e) => set('maxUses', e.target.value.replace(/\D/g, '').slice(0, 7))} placeholder="sem limite" /></label>
        <label className="field"><span>Usos por cliente (telefone)</span><input inputMode="numeric" value={f.maxUsesPerPhone} onChange={(e) => set('maxUsesPerPhone', e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="sem limite" /></label>
      </div>
      <Toggle checked={f.firstOrderOnly} onChange={(v) => set('firstOrderOnly', v)} label="Só para o primeiro pedido do cliente" />
      <Toggle checked={f.active} onChange={(v) => set('active', v)} label="Cupom ativo" />
    </Modal>
  );
}
