import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, formatDateTime, storage } from '../../lib/api';
import { canManage, useSession } from '../session';
import { Confirm, Modal, Toggle, errorText, useToast } from '../ui';
import {
  DEFAULT_PREFS, LabelFace, STORAGE_LABELS, TARGET_LABELS, TYPE_LABELS, loadTarget, saveTarget, formatShelfLife, labelDate, loadPrefs, savePrefs, toLocalInput, useLabelPrinter,
  type LabelData, type LabelType, type PrintPrefs, type PrintTarget, type Storage,
} from './labelPrint';

interface LabelProduct {
  id: string; name: string; groupName: string; chilledHours: number | null; frozenHours: number | null; ambientHours: number | null;
  defaultStorage: Storage; notes: string; active: boolean;
}
interface LabelPrint extends Omit<LabelData, 'notes'> {
  id: string; productId: string | null; copies: number; status: 'active' | 'used' | 'discarded'; closedAt: string | null; closeReason: string;
  printedByName: string | null; createdAt: string;
}
interface CatalogData { products: LabelProduct[]; store: { name: string }; responsibles: string[] }

const hoursOf = (p: LabelProduct, s: Storage) => ({ chilled: p.chilledHours, frozen: p.frozenHours, ambient: p.ambientHours })[s];
const STORAGES: Storage[] = ['chilled', 'frozen', 'ambient'];

function useCatalog() {
  const [data, setData] = useState<CatalogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<CatalogData>('/api/admin/labels/products').then((d) => { setData(d); setError(null); }).catch((e) => setError(errorText(e))), []);
  useEffect(() => { load(); }, [load]);
  return { data, error, reload: load };
}

export function LabelsTab() {
  const { user } = useSession();
  const catalog = useCatalog();
  const printer = useLabelPrinter();
  const items = [['imprimir', 'Imprimir'], ['vencimentos', 'Vencimentos'], ['produtos', 'Produtos e prazos'], ['ajustes', 'Ajustes de impressão']];
  return (
    <div className="a-settings">
      <nav className="a-subnav" aria-label="Etiquetas">
        {items.map(([path, label]) => <NavLink key={path} to={`/admin/etiquetas/${path}`}>{label}</NavLink>)}
      </nav>
      <div className="a-settings-body">
        {catalog.error && <div className="alert alert-error">{catalog.error}</div>}
        {!catalog.data && !catalog.error && <p className="muted">Carregando…</p>}
        {catalog.data && (
          <Routes>
            <Route path="imprimir" element={<PrintForm catalog={catalog.data} onPrinted={catalog.reload} printer={printer} />} />
            <Route path="vencimentos" element={<ExpiryList storeName={catalog.data.store.name} printer={printer} />} />
            <Route path="produtos" element={<ProductsSettings products={catalog.data.products} canEdit={canManage(user)} onSaved={catalog.reload} />} />
            <Route path="ajustes" element={<PrintAdjust printer={printer} />} />
            <Route path="*" element={<Navigate to="imprimir" replace />} />
          </Routes>
        )}
      </div>
      {printer.portal}
    </div>
  );
}

type Printer = ReturnType<typeof useLabelPrinter>;

// ---------------------------------------------------------------- Imprimir
function PrintForm({ catalog, onPrinted, printer }: { catalog: CatalogData; onPrinted: () => void; printer: Printer }) {
  const { user } = useSession();
  const toast = useToast();
  const active = catalog.products.filter((p) => p.active);
  const [productId, setProductId] = useState<string>(active[0]?.id ?? '');
  const [freeName, setFreeName] = useState('');
  const [labelType, setLabelType] = useState<LabelType>('handled');
  const [storageSel, setStorageSel] = useState<Storage>(active[0]?.defaultStorage ?? 'chilled');
  const [handled, setHandled] = useState(() => toLocalInput(new Date()));
  const [manual, setManual] = useState(false);
  const [manualExp, setManualExp] = useState('');
  const [responsible, setResponsible] = useState(() => storage.get('rg_label_responsible', user.name));
  const [quantityText, setQuantityText] = useState('');
  const [extra, setExtra] = useState('');
  const [copies, setCopies] = useState(1);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [target, setTargetState] = useState<PrintTarget>(loadTarget);
  const setTarget = (t: PrintTarget) => { setTargetState(t); saveTarget(t); };

  const product = active.find((p) => p.id === productId) ?? null;
  const productHours = product ? hoursOf(product, storageSel) : null;
  const needsManual = !product || productHours == null;
  const useManual = manual || needsManual;

  function pickProduct(id: string) {
    setProductId(id);
    const p = active.find((x) => x.id === id);
    if (p) setStorageSel(p.defaultStorage);
    setManual(false);
  }

  const handledIso = handled ? new Date(handled).toISOString() : '';
  const expiresIso = useManual
    ? (manualExp ? new Date(manualExp).toISOString() : '')
    : handledIso && productHours != null ? new Date(new Date(handled).getTime() + productHours * 3600_000).toISOString() : '';

  const preview: LabelData = {
    productName: product?.name ?? freeName.trim(), labelType, storage: storageSel, handledAt: handledIso, expiresAt: expiresIso,
    responsible: responsible.trim(), lot: 'AAMMDD-000', quantityText: quantityText.trim(), extra: extra.trim(), notes: product?.notes,
  };

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? active.filter((p) => p.name.toLowerCase().includes(f) || p.groupName.toLowerCase().includes(f)) : active;
  }, [active, filter]);
  const groups = useMemo(() => {
    const m = new Map<string, LabelProduct[]>();
    for (const p of visible) m.set(p.groupName || 'Sem grupo', [...(m.get(p.groupName || 'Sem grupo') ?? []), p]);
    return [...m.entries()];
  }, [visible]);

  async function submit() {
    if (!preview.productName) return toast('Escolha um produto ou digite o nome.', 'error');
    if (!expiresIso) return toast('Informe a validade.', 'error');
    setBusy(true);
    try {
      const r = await api<{ print: LabelPrint }>('/api/admin/labels/prints', {
        body: {
          productId: product?.id ?? null, productName: product ? '' : freeName.trim(), labelType, storage: storageSel,
          handledAt: handledIso, manualExpiresAt: useManual ? expiresIso : null, responsible: responsible.trim(),
          quantityText: quantityText.trim(), extra: extra.trim(), copies, target,
        },
      });
      storage.set('rg_label_responsible', responsible.trim());
      if (target === 'browser') {
        printer.printLabels({ ...r.print, notes: product?.notes }, copies, catalog.store.name);
        toast(`Lote ${r.print.lot} registrado. Imprimindo ${copies} etiqueta(s)…`);
      } else {
        toast(`Lote ${r.print.lot} enviado para a Epson (${copies} etiqueta${copies > 1 ? 's' : ''}). Acompanhe em Configurações › Impressora.`);
      }
      onPrinted();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lbl-layout">
      <div>
        <h2>Imprimir etiquetas de validade</h2>
        {!active.length && (
          <p className="alert alert-info">Nenhum produto cadastrado ainda. Cadastre os insumos e preparos com os prazos em <NavLink to="/admin/etiquetas/produtos">Produtos e prazos</NavLink>, ou digite o nome abaixo para uma etiqueta avulsa.</p>
        )}
        <label className="field"><span>Produto</span>
          {active.length > 6 && <input placeholder="Buscar produto…" value={filter} onChange={(e) => setFilter(e.target.value)} className="lbl-search" />}
          <select value={productId} onChange={(e) => pickProduct(e.target.value)}>
            {groups.map(([g, ps]) => (
              <optgroup key={g} label={g}>{ps.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
            ))}
            <option value="">Outro (digitar o nome)</option>
          </select>
        </label>
        {!product && (
          <label className="field"><span>Nome do produto</span><input value={freeName} onChange={(e) => setFreeName(e.target.value)} maxLength={60} placeholder="Ex.: Molho especial" /></label>
        )}
        <div className="field"><span>Tipo</span>
          <div className="chips wrap">
            {(Object.keys(TYPE_LABELS) as LabelType[]).map((t) => (
              <button type="button" key={t} className={`chip ${labelType === t ? 'active' : ''}`} onClick={() => setLabelType(t)}>{TYPE_LABELS[t]}</button>
            ))}
          </div>
        </div>
        <div className="field"><span>Conservação</span>
          <div className="chips wrap">
            {STORAGES.map((s) => {
              const h = product ? hoursOf(product, s) : null;
              return (
                <button type="button" key={s} className={`chip ${storageSel === s ? 'active' : ''}`} onClick={() => setStorageSel(s)}>
                  {STORAGE_LABELS[s]}{product ? ` · ${formatShelfLife(h)}` : ''}
                </button>
              );
            })}
          </div>
        </div>
        <div className="grid-2">
          <label className="field"><span>Manipulação</span>
            <div className="a-row">
              <input type="datetime-local" value={handled} onChange={(e) => setHandled(e.target.value)} />
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setHandled(toLocalInput(new Date()))}>Agora</button>
            </div>
          </label>
          <label className="field"><span>Validade</span>
            {useManual
              ? <input type="datetime-local" value={manualExp} onChange={(e) => setManualExp(e.target.value)} />
              : <output className="lbl-computed">{expiresIso ? labelDate(expiresIso, true) : '—'} <small className="muted">({formatShelfLife(productHours)})</small></output>}
          </label>
        </div>
        {!needsManual && <Toggle checked={manual} onChange={(v) => { setManual(v); if (v && expiresIso) setManualExp(toLocalInput(new Date(expiresIso))); }} label="Validade diferente do prazo cadastrado (ex.: embalagem vence antes)" />}
        {product && productHours == null && <p className="muted small">Esse produto não tem prazo cadastrado para {STORAGE_LABELS[storageSel].toLowerCase()}. Informe a validade.</p>}
        <div className="grid-2">
          <label className="field"><span>Responsável</span>
            <input value={responsible} onChange={(e) => setResponsible(e.target.value)} maxLength={40} list="lbl-responsibles" />
            <datalist id="lbl-responsibles">{catalog.responsibles.map((r) => <option key={r} value={r} />)}</datalist>
          </label>
          <label className="field"><span>Quantidade / peso (opcional)</span><input value={quantityText} onChange={(e) => setQuantityText(e.target.value)} maxLength={20} placeholder="Ex.: 2 kg, 500 ml, 10 un" /></label>
        </div>
        <label className="field"><span>Informação extra (opcional)</span><input value={extra} onChange={(e) => setExtra(e.target.value)} maxLength={40} placeholder="Ex.: marca, fornecedor, lote do fabricante" /></label>
        <div className="field"><span>Quantidade de etiquetas</span>
          <div className="stepper small">
            <button type="button" onClick={() => setCopies((c) => Math.max(1, c - 1))} aria-label="Menos">−</button>
            <span>{copies}</span>
            <button type="button" onClick={() => setCopies((c) => Math.min(50, c + 1))} aria-label="Mais">+</button>
          </div>
        </div>
        <div className="field"><span>Imprimir em</span>
          <div className="chips wrap">
            {(['agent', 'browser'] as PrintTarget[]).map((t) => (
              <button type="button" key={t} className={`chip ${target === t ? 'active' : ''}`} onClick={() => setTarget(t)}>{TARGET_LABELS[t]}</button>
            ))}
          </div>
          {target === 'agent' && <p className="muted small">Sai na Epson pelo agente, uma etiqueta por corte (papel de 80 mm, não fica 50x30). Use bobina comum e prenda com fita, ou bobina adesiva contínua.</p>}
        </div>
        <button className="btn btn-primary btn-lg btn-block" disabled={busy || printer.busy} onClick={submit}>
          {busy ? 'Registrando…' : `Imprimir ${copies} etiqueta${copies > 1 ? 's' : ''}`}
        </button>
        <p className="muted small">O lote é gerado na hora da impressão e fica no histórico em Vencimentos.</p>
      </div>
      <aside className="lbl-preview-col">
        <h3>Prévia (50 x 30 mm)</h3>
        <div className="lbl-preview"><div className="lbl-sheet"><LabelFace data={preview} storeName={catalog.store.name} /></div></div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------- Vencimentos
function ExpiryList({ storeName, printer }: { storeName: string; printer: Printer }) {
  const toast = useToast();
  const [showAll, setShowAll] = useState(false);
  const [q, setQ] = useState('');
  const [data, setData] = useState<{ prints: LabelPrint[]; summary: { expired: number; expiring: number; active: number } } | null>(null);
  const [closing, setClosing] = useState<{ p: LabelPrint; status: 'used' | 'discarded' } | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ status: showAll ? 'all' : 'active' });
      if (q.trim()) params.set('q', q.trim());
      setData(await api(`/api/admin/labels/prints?${params}`));
      setNow(Date.now());
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }, [showAll, q, toast]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => { const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  async function reprint(p: LabelPrint) {
    if (loadTarget() === 'browser') return printer.printLabels(p, 1, storeName);
    try {
      await api(`/api/admin/labels/prints/${p.id}/agent`, { body: { copies: 1 } });
      toast(`Lote ${p.lot} enviado para a Epson`);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  function badge(p: LabelPrint) {
    if (p.status === 'used') return <span className="badge lbl-b-used">Usado</span>;
    if (p.status === 'discarded') return <span className="badge badge-closed">Descartado</span>;
    const left = new Date(p.expiresAt).getTime() - now;
    if (left <= 0) return <span className="badge badge-closed">Vencido</span>;
    if (left <= 24 * 3600_000) return <span className="badge badge-warning">Vence em 24 h</span>;
    return <span className="badge badge-open">No prazo</span>;
  }

  return (
    <div>
      <h2>Controle de vencimentos</h2>
      {data && (
        <div className="lbl-summary">
          <div className="card"><strong className="lbl-n err">{data.summary.expired}</strong><span>Vencidos no estoque</span></div>
          <div className="card"><strong className="lbl-n warn">{data.summary.expiring}</strong><span>Vencem em 24 h</span></div>
          <div className="card"><strong className="lbl-n">{data.summary.active}</strong><span>Etiquetas ativas</span></div>
        </div>
      )}
      <div className="a-row wrap">
        <input className="lbl-search grow" placeholder="Buscar por produto, lote ou responsável" value={q} onChange={(e) => setQ(e.target.value)} />
        <Toggle checked={showAll} onChange={setShowAll} label="Mostrar também as baixadas" />
      </div>
      {data && !data.prints.length && <p className="muted">{showAll ? 'Nenhuma etiqueta encontrada.' : 'Nenhuma etiqueta ativa. Ao imprimir, o item aparece aqui até receber baixa (usado ou descartado).'}</p>}
      <table className="a-table">
        {!!data?.prints.length && <thead><tr><th>Produto</th><th>Validade</th><th>Situação</th><th>Lote / resp.</th><th /></tr></thead>}
        <tbody>
          {data?.prints.map((p) => (
            <tr key={p.id} className={p.status === 'active' ? '' : 'inactive'}>
              <td><strong>{p.productName}</strong><div className="muted small">{TYPE_LABELS[p.labelType]} · {STORAGE_LABELS[p.storage]}{p.quantityText ? ` · ${p.quantityText}` : ''}</div></td>
              <td>{labelDate(p.expiresAt, true)}<div className="muted small">manip. {labelDate(p.handledAt)}</div></td>
              <td>{badge(p)}{p.closeReason && <div className="muted small">{p.closeReason}</div>}</td>
              <td>{p.lot}<div className="muted small">{p.responsible}{p.copies > 1 ? ` · ${p.copies} etiq.` : ''}</div></td>
              <td>
                <div className="a-row wrap lbl-actions">
                  <button className="btn btn-secondary btn-sm" disabled={printer.busy} onClick={() => reprint(p)}>Reimprimir</button>
                  {p.status === 'active' && <>
                    <button className="btn btn-secondary btn-sm" onClick={() => setClosing({ p, status: 'used' })}>Usado</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => setClosing({ p, status: 'discarded' })}>Descartar</button>
                  </>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {closing && (
        <Confirm
          title={closing.status === 'used' ? 'Dar baixa como usado' : 'Registrar descarte'}
          text={`${closing.p.productName} · lote ${closing.p.lot}. ${closing.status === 'discarded' ? 'O descarte fica registrado como perda.' : 'O item sai da lista de vencimentos.'}`}
          confirmLabel={closing.status === 'used' ? 'Dar baixa' : 'Descartar'}
          danger={closing.status === 'discarded'}
          requireReason={closing.status === 'discarded' ? 'Motivo (ex.: venceu, contaminado, sobra)' : 'Observação (opcional)'}
          reasonOptional={closing.status === 'used'}
          onClose={() => setClosing(null)}
          onConfirm={async (reason) => {
            try {
              await api(`/api/admin/labels/prints/${closing.p.id}/close`, { body: { status: closing.status, reason } });
              toast(closing.status === 'used' ? 'Baixa registrada' : 'Descarte registrado');
              load();
            } catch (e) {
              toast(errorText(e), 'error');
            }
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Produtos e prazos
function ProductsSettings({ products, canEdit, onSaved }: { products: LabelProduct[]; canEdit: boolean; onSaved: () => void }) {
  const [edit, setEdit] = useState<Partial<LabelProduct> | null>(null);
  return (
    <div>
      <div className="a-section-head">
        <h2>Produtos e prazos de validade</h2>
        {canEdit && <button className="btn btn-primary btn-sm" onClick={() => setEdit({ defaultStorage: 'chilled', active: true })}>+ Produto</button>}
      </div>
      <p className="muted small">Cadastre os insumos e preparos que recebem etiqueta e o prazo de cada forma de conservação, conforme o manual de boas práticas da loja. Deixe em branco a conservação que não se aplica.</p>
      {!canEdit && <p className="alert alert-info">Somente gerente ou dono alteram os prazos.</p>}
      {!products.length && <p className="muted">Nenhum produto cadastrado.</p>}
      {!!products.length && (
        <table className="a-table">
          <thead><tr><th>Produto</th><th>Grupo</th><th>Resfriado</th><th>Congelado</th><th>Ambiente</th><th /></tr></thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id} className={p.active ? '' : 'inactive'}>
                <td>{p.name}{!p.active && ' (inativo)'}{p.notes && <div className="muted small">{p.notes}</div>}</td>
                <td>{p.groupName || '—'}</td>
                {STORAGES.map((s) => <td key={s}>{formatShelfLife(hoursOf(p, s))}{p.defaultStorage === s && <span className="muted small"> (padrão)</span>}</td>)}
                <td>{canEdit && <button className="btn btn-secondary btn-sm" onClick={() => setEdit(p)}>Editar</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && <ProductModal p={edit} groups={[...new Set(products.map((p) => p.groupName).filter(Boolean))]} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onSaved(); }} />}
    </div>
  );
}

type Unit = 'h' | 'd';
const splitHours = (h: number | null | undefined): { v: string; u: Unit } =>
  h == null ? { v: '', u: 'd' } : h % 24 === 0 ? { v: String(h / 24), u: 'd' } : { v: String(h), u: 'h' };

function ProductModal({ p, groups, onClose, onSaved }: { p: Partial<LabelProduct>; groups: string[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(p.name ?? '');
  const [groupName, setGroupName] = useState(p.groupName ?? '');
  const [notes, setNotes] = useState(p.notes ?? '');
  const [active, setActive] = useState(p.active ?? true);
  const [def, setDef] = useState<Storage>(p.defaultStorage ?? 'chilled');
  const [life, setLife] = useState<Record<Storage, { v: string; u: Unit }>>({
    chilled: splitHours(p.chilledHours), frozen: splitHours(p.frozenHours), ambient: splitHours(p.ambientHours),
  });
  const toHours = (s: Storage) => {
    const n = Number(life[s].v.replace(',', '.'));
    if (!life[s].v.trim() || !Number.isFinite(n) || n <= 0) return null;
    return Math.round(life[s].u === 'd' ? n * 24 : n);
  };
  async function save() {
    const body = { name, groupName, notes, active, defaultStorage: def, chilledHours: toHours('chilled'), frozenHours: toHours('frozen'), ambientHours: toHours('ambient') };
    try {
      if (p.id) await api(`/api/admin/labels/products/${p.id}`, { method: 'PUT', body });
      else await api('/api/admin/labels/products', { body });
      toast('Produto salvo');
      onSaved();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }
  return (
    <Modal title={p.id ? 'Editar produto de etiqueta' : 'Novo produto de etiqueta'} onClose={onClose} footer={<button className="btn btn-primary btn-block" onClick={save}>Salvar</button>}>
      <label className="field"><span>Nome (sai na etiqueta)</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Ex.: Frango desfiado" /></label>
      <label className="field"><span>Grupo (opcional)</span>
        <input value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={40} list="lbl-groups" placeholder="Ex.: Carnes, Molhos, Hortifrúti" />
        <datalist id="lbl-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
      </label>
      <fieldset className="a-fieldset">
        <legend>Validade por conservação</legend>
        {STORAGES.map((s) => (
          <div key={s} className="lbl-life-row">
            <span>{STORAGE_LABELS[s]}</span>
            <input inputMode="decimal" value={life[s].v} onChange={(e) => setLife({ ...life, [s]: { ...life[s], v: e.target.value } })} placeholder="—" aria-label={`Prazo ${STORAGE_LABELS[s]}`} />
            <select value={life[s].u} onChange={(e) => setLife({ ...life, [s]: { ...life[s], u: e.target.value as Unit } })} aria-label="Unidade">
              <option value="d">dias</option>
              <option value="h">horas</option>
            </select>
            <label className="lbl-radio"><input type="radio" name="def" checked={def === s} onChange={() => setDef(s)} /> padrão</label>
          </div>
        ))}
      </fieldset>
      <label className="field"><span>Observação curta na etiqueta (opcional)</span><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={60} placeholder="Ex.: Manter até 4 °C" /></label>
      <Toggle checked={active} onChange={setActive} label="Ativo (aparece para imprimir)" />
    </Modal>
  );
}

// ---------------------------------------------------------------- Ajustes de impressão (por computador)
function PrintAdjust({ printer }: { printer: Printer }) {
  const toast = useToast();
  const [p, setP] = useState<PrintPrefs>(loadPrefs);
  const num = (k: keyof PrintPrefs, min: number, max: number) => (e: ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value.replace(',', '.'));
    if (Number.isFinite(v)) setP({ ...p, [k]: Math.min(max, Math.max(min, v)) });
  };
  return (
    <div>
      <h2>Ajustes de impressão</h2>
      <p className="alert alert-info">Estes ajustes valem para a <strong>impressora de etiqueta 50x30</strong> (impressão pelo navegador). Na Epson do caixa, a etiqueta sai pelo agente com o layout da bobina e corte automático; ela precisa do agente 1.6.0 ou mais novo, que se atualiza sozinho.</p>
      <p className="muted small">Ficam salvos neste computador/navegador. Etiqueta: 50 x 30 mm com {p.gapMm} mm de espaço entre uma e outra.</p>
      <div className="field"><span>Tipo de papel</span>
        <div className="chips wrap">
          <button type="button" className={`chip ${p.mode === 'gap' ? 'active' : ''}`} onClick={() => setP({ ...p, mode: 'gap' })}>Etiqueta destacável (com espaço)</button>
          <button type="button" className={`chip ${p.mode === 'continuous' ? 'active' : ''}`} onClick={() => setP({ ...p, mode: 'continuous' })}>Papel contínuo</button>
        </div>
        <p className="muted small">
          {p.mode === 'gap'
            ? 'Recomendado. Cada etiqueta é uma página de 50 x 30 mm; o driver da impressora usa o sensor para pular o espaço entre etiquetas. No driver, configure papel 50 x 30 mm, tipo "etiqueta com espaço (gap)" e espaço de 4 mm.'
            : `Para impressora sem sensor de espaço: cada página fica com ${30 + p.gapMm} mm (30 mm da etiqueta + ${p.gapMm} mm de espaço).`}
        </p>
      </div>
      <div className="grid-2">
        <label className="field"><span>Espaço entre etiquetas (mm)</span><input type="number" step="0.5" min={0} max={10} value={p.gapMm} onChange={num('gapMm', 0, 10)} /></label>
        <label className="field"><span>Margem interna (mm)</span><input type="number" step="0.5" min={0} max={5} value={p.marginMm} onChange={num('marginMm', 0, 5)} /></label>
        <label className="field"><span>Deslocar para a direita (mm, negativo = esquerda)</span><input type="number" step="0.5" min={-5} max={5} value={p.offsetXmm} onChange={num('offsetXmm', -5, 5)} /></label>
        <label className="field"><span>Deslocar para baixo (mm, negativo = cima)</span><input type="number" step="0.5" min={-5} max={5} value={p.offsetYmm} onChange={num('offsetYmm', -5, 5)} /></label>
      </div>
      <div className="a-row wrap">
        <button className="btn btn-primary" onClick={() => { savePrefs(p); toast('Ajustes salvos neste computador'); }}>Salvar ajustes</button>
        <button className="btn btn-secondary" disabled={printer.busy} onClick={() => { savePrefs(p); printer.printCalibration(2); }}>Imprimir teste de alinhamento</button>
        <button className="btn btn-ghost" onClick={() => setP(DEFAULT_PREFS)}>Voltar ao padrão</button>
      </div>
      <section className="card lbl-help">
        <h3>Como deixar a impressão certa (Chrome ou Edge)</h3>
        <ol>
          <li>Instale o driver da impressora de etiquetas no Windows e crie o papel <strong>50 x 30 mm</strong> (em alguns drivers: "Largura 50, Altura 30, Espaço 4").</li>
          <li>Na janela de impressão, escolha a impressora de etiquetas, <strong>Margens: Nenhuma</strong>, <strong>Escala: Padrão (100%)</strong> e desmarque <strong>Cabeçalhos e rodapés</strong>. O navegador lembra essas opções.</li>
          <li>Imprima o teste de alinhamento. Se a moldura sair cortada ou torta, ajuste os deslocamentos acima.</li>
          <li>Opcional: para imprimir sem a janela de confirmação, abra o painel por um atalho do Chrome com <code>--kiosk-printing</code> (usa a última impressora escolhida).</li>
        </ol>
        <p className="muted small">A Epson TM-T20 do caixa é de cupom (bobina contínua de 80 mm), sem sensor de espaço: não imprime em rolo de etiqueta 50 x 30 mm. Nela, use a opção "Epson do caixa (bobina)" na tela Imprimir.</p>
      </section>
    </div>
  );
}
