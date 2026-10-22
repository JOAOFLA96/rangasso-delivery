import { useCallback, useEffect, useState } from 'react';
import { api, brl } from '../../lib/api';
import { canManage, useSession } from '../session';
import { Confirm, Modal, Toggle, errorText, useToast } from '../ui';
import { centsToInput, inputToCents } from './useSettings';

interface AddonRow { id?: string; name: string; priceCents: number; available: boolean }
interface Group { id: string; name: string; minSelect: number; maxSelect: number; active: boolean; addons: AddonRow[] }
interface Product {
  id: string; categoryId: string; name: string; description: string; imageUrl: string | null; priceCents: number;
  promoPriceCents: number | null; promoActive: boolean; promoStartsAt: string | null; promoEndsAt: string | null; promoValidNow: boolean;
  available: boolean; active: boolean; trackStock: boolean; stockQty: number | null; sortOrder: number; addonGroups: Group[];
}
interface Category { id: string; name: string; description: string; active: boolean; sortOrder: number }

export function MenuSettings() {
  const { user } = useSession();
  const manage = canManage(user);
  const toast = useToast();
  const [cats, setCats] = useState<Category[]>([]);
  const [prods, setProds] = useState<Product[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editCat, setEditCat] = useState<Partial<Category> | null>(null);
  const [editProd, setEditProd] = useState<Partial<Product> | null>(null);
  const [confirm, setConfirm] = useState<null | { title: string; text: string; run: () => Promise<void> }>(null);

  const load = useCallback(async () => {
    const r = await api<{ categories: Category[]; products: Product[] }>('/api/admin/menu');
    setCats(r.categories);
    setProds(r.products);
    setLoaded(true);
  }, []);
  useEffect(() => { load().catch((e) => toast(errorText(e), 'error')); }, [load, toast]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok);
      await load();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const move = (list: { id: string }[], idx: number, dir: -1 | 1, url: string) => {
    const ids = list.map((x) => x.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    run(() => api(url, { body: { ids } }));
  };

  if (!loaded) return <p className="muted">Carregando cardápio…</p>;

  return (
    <div>
      <div className="a-section-head">
        <h2>Cardápio</h2>
        {manage && (
          <div className="a-row">
            <button className="btn btn-secondary btn-sm" onClick={() => setEditCat({ name: '', description: '', active: true })}>+ Categoria</button>
            <button className="btn btn-primary btn-sm" disabled={!cats.length} onClick={() => setEditProd({ categoryId: cats[0]?.id, name: '', description: '', priceCents: 0, available: true, active: true, promoActive: false, trackStock: false, addonGroups: [] })}>+ Produto</button>
          </div>
        )}
      </div>
      <p className="muted small">Alterações salvas aqui aparecem no cardápio público na hora. "Disponível" controla o "acabou por hoje"; "Ativo" controla se o produto aparece.</p>
      {!cats.length && <div className="state-box"><p className="muted">Nenhuma categoria ainda. Comece criando uma categoria.</p></div>}

      {cats.map((c, ci) => {
        const items = prods.filter((p) => p.categoryId === c.id);
        return (
          <section key={c.id} className="a-cat">
            <div className="a-cat-head">
              <h3>{c.name} {!c.active && <span className="pill pill-sm p-wait">Oculta</span>}</h3>
              {manage && (
                <div className="a-row">
                  <button className="btn btn-ghost btn-sm" aria-label="Subir categoria" onClick={() => move(cats, ci, -1, '/api/admin/categories/reorder')} disabled={ci === 0}>↑</button>
                  <button className="btn btn-ghost btn-sm" aria-label="Descer categoria" onClick={() => move(cats, ci, 1, '/api/admin/categories/reorder')} disabled={ci === cats.length - 1}>↓</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setEditCat(c)}>Editar</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setConfirm({ title: `Excluir a categoria "${c.name}"?`, text: 'Ela precisa estar sem produtos. A categoria some do cardápio; pedidos antigos não são afetados.', run: () => run(() => api(`/api/admin/categories/${c.id}`, { method: 'DELETE' }), 'Categoria excluída') })}>Excluir</button>
                </div>
              )}
            </div>
            {!items.length && <p className="muted small">Sem produtos nesta categoria.</p>}
            <ul className="a-prod-list">
              {items.map((p, pi) => (
                <li key={p.id} className={`a-prod ${p.active ? '' : 'inactive'}`}>
                  {p.imageUrl ? <img src={p.imageUrl} alt="" className="a-prod-img" /> : <div className="a-prod-img empty" aria-hidden="true">sem foto</div>}
                  <div className="a-prod-info">
                    <strong>{p.name}</strong>
                    <span className="small">
                      {p.promoValidNow ? <><s className="muted">{brl(p.priceCents)}</s> <b className="promo-text">{brl(p.promoPriceCents)}</b></> : brl(p.priceCents)}
                      {p.promoActive && !p.promoValidNow && <span className="muted"> · promoção fora do período</span>}
                      {!p.active && <span className="muted"> · inativo (oculto)</span>}
                      {p.addonGroups.length > 0 && <span className="muted"> · {p.addonGroups.length} grupo(s) de adicionais</span>}
                    </span>
                    <div className="a-row wrap">
                      <Toggle checked={p.available} label={p.available ? 'Disponível' : 'Esgotado'} onChange={(v) => run(() => api(`/api/admin/products/${p.id}/availability`, { method: 'PATCH', body: { available: v } }), v ? `${p.name} disponível` : `${p.name} marcado como esgotado`)} />
                      {p.trackStock && <StockEditor p={p} onSave={(q) => run(() => api(`/api/admin/products/${p.id}/availability`, { method: 'PATCH', body: { stockQty: q } }), 'Estoque atualizado')} />}
                    </div>
                  </div>
                  {manage && (
                    <div className="a-prod-actions">
                      <button className="btn btn-ghost btn-sm" aria-label="Subir produto" disabled={pi === 0} onClick={() => move(items, pi, -1, '/api/admin/products/reorder')}>↑</button>
                      <button className="btn btn-ghost btn-sm" aria-label="Descer produto" disabled={pi === items.length - 1} onClick={() => move(items, pi, 1, '/api/admin/products/reorder')}>↓</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => setEditProd(p)}>Editar</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {editCat && <CategoryModal cat={editCat} onClose={() => setEditCat(null)} onSaved={() => { setEditCat(null); load(); }} />}
      {editProd && (
        <ProductModal
          product={editProd}
          categories={cats}
          onClose={() => { setEditProd(null); load(); }}
          onArchive={(p) => setConfirm({ title: `Excluir "${p.name}"?`, text: 'O produto sai do cardápio e do painel. Pedidos antigos continuam com o nome e o preço da época.', run: () => run(async () => { await api(`/api/admin/products/${p.id}`, { method: 'DELETE' }); setEditProd(null); }, 'Produto excluído') })}
        />
      )}
      {confirm && <Confirm title={confirm.title} text={confirm.text} confirmLabel="Excluir" danger onClose={() => setConfirm(null)} onConfirm={confirm.run} />}
    </div>
  );
}

function StockEditor({ p, onSave }: { p: Product; onSave: (q: number) => void }) {
  const [v, setV] = useState(String(p.stockQty ?? 0));
  useEffect(() => setV(String(p.stockQty ?? 0)), [p.stockQty]);
  return (
    <label className="inline-field stock">
      <span>Estoque</span>
      <input inputMode="numeric" value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, '').slice(0, 6))} onBlur={() => Number(v) !== p.stockQty && onSave(Number(v || 0))} aria-label={`Estoque de ${p.name}`} />
    </label>
  );
}

function CategoryModal({ cat, onClose, onSaved }: { cat: Partial<Category>; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: cat.name ?? '', description: cat.description ?? '', active: cat.active ?? true });
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      if (cat.id) await api(`/api/admin/categories/${cat.id}`, { method: 'PUT', body: f });
      else await api('/api/admin/categories', { body: f });
      toast('Categoria salva');
      onSaved();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={cat.id ? 'Editar categoria' : 'Nova categoria'} onClose={onClose} footer={<button className="btn btn-primary btn-block" disabled={busy || !f.name.trim()} onClick={save}>Salvar</button>}>
      <label className="field"><span>Nome</span><input value={f.name} maxLength={60} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></label>
      <label className="field"><span>Descrição (opcional)</span><input value={f.description} maxLength={200} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Mostrar no cardápio" />
    </Modal>
  );
}

const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

function ProductModal({ product, categories, onClose, onArchive }: { product: Partial<Product>; categories: Category[]; onClose: () => void; onArchive: (p: Product) => void }) {
  const toast = useToast();
  const [p, setP] = useState<Partial<Product>>(product);
  const [f, setF] = useState({
    categoryId: product.categoryId ?? categories[0]?.id ?? '', name: product.name ?? '', description: product.description ?? '',
    price: centsToInput(product.priceCents ?? null), promoPrice: centsToInput(product.promoPriceCents), promoActive: product.promoActive ?? false,
    promoStartsAt: toLocalInput(product.promoStartsAt), promoEndsAt: toLocalInput(product.promoEndsAt), available: product.available ?? true,
    active: product.active ?? true, trackStock: product.trackStock ?? false, stockQty: product.stockQty != null ? String(product.stockQty) : '',
  });
  const [busy, setBusy] = useState(false);
  const [groups, setGroups] = useState<Group[]>(product.addonGroups ?? []);

  async function save() {
    const priceCents = inputToCents(f.price);
    const promoPriceCents = inputToCents(f.promoPrice);
    if (priceCents == null || Number.isNaN(priceCents)) return toast('Preço inválido. Use o formato 32,90.', 'error');
    if (Number.isNaN(promoPriceCents)) return toast('Preço promocional inválido.', 'error');
    const body = {
      categoryId: f.categoryId, name: f.name.trim(), description: f.description.trim(), priceCents, promoPriceCents,
      promoActive: f.promoActive, promoStartsAt: fromLocalInput(f.promoStartsAt), promoEndsAt: fromLocalInput(f.promoEndsAt),
      available: f.available, active: f.active, trackStock: f.trackStock, stockQty: f.trackStock ? Number(f.stockQty || 0) : null,
    };
    setBusy(true);
    try {
      const saved = p.id ? await api<Product>(`/api/admin/products/${p.id}`, { method: 'PUT', body }) : await api<Product>('/api/admin/products', { body });
      setP({ ...saved, addonGroups: groups });
      toast(p.id ? 'Produto salvo' : 'Produto criado. Agora você pode adicionar foto e adicionais.');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    const form = new FormData();
    form.append('file', file);
    try {
      const r = await api<{ imageUrl: string }>(`/api/admin/products/${p.id}/image`, { form });
      setP({ ...p, imageUrl: r.imageUrl });
      toast('Foto atualizada');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  async function reloadGroups() {
    const r = await api<{ products: Product[] }>('/api/admin/menu');
    setGroups(r.products.find((x) => x.id === p.id)?.addonGroups ?? []);
  }

  return (
    <Modal wide title={p.id ? `Editar: ${p.name}` : 'Novo produto'} onClose={onClose} footer={
      <>
        {p.id && <button className="btn btn-ghost" onClick={() => onArchive(p as Product)}>Excluir</button>}
        <button className="btn btn-primary btn-grow" disabled={busy || !f.name.trim()} onClick={save}>{busy ? 'Salvando…' : 'Salvar produto'}</button>
      </>
    }>
      <div className="grid-2">
        <label className="field"><span>Nome</span><input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field"><span>Categoria</span>
          <select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>
      <label className="field"><span>Descrição</span><textarea value={f.description} maxLength={500} rows={2} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <div className="grid-2">
        <label className="field"><span>Preço (R$)</span><input inputMode="decimal" placeholder="0,00" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></label>
        <div className="field"><span>Visibilidade</span>
          <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Ativo (aparece no cardápio)" />
          <Toggle checked={f.available} onChange={(v) => setF({ ...f, available: v })} label="Disponível para pedido" />
        </div>
      </div>

      <fieldset className="a-fieldset">
        <legend>Promoção</legend>
        <Toggle checked={f.promoActive} onChange={(v) => setF({ ...f, promoActive: v })} label="Promoção ligada" />
        <div className="grid-3">
          <label className="field"><span>Preço promocional (R$)</span><input inputMode="decimal" value={f.promoPrice} onChange={(e) => setF({ ...f, promoPrice: e.target.value })} /></label>
          <label className="field"><span>Início (opcional)</span><input type="datetime-local" value={f.promoStartsAt} onChange={(e) => setF({ ...f, promoStartsAt: e.target.value })} /></label>
          <label className="field"><span>Fim (opcional)</span><input type="datetime-local" value={f.promoEndsAt} onChange={(e) => setF({ ...f, promoEndsAt: e.target.value })} /></label>
        </div>
        <p className="muted small">Fora do período, o cardápio volta sozinho ao preço normal. O servidor confere a validade no momento do pedido.</p>
      </fieldset>

      <fieldset className="a-fieldset">
        <legend>Estoque</legend>
        <Toggle checked={f.trackStock} onChange={(v) => setF({ ...f, trackStock: v })} label="Controlar estoque deste produto" />
        {f.trackStock && <label className="field"><span>Quantidade disponível</span><input inputMode="numeric" value={f.stockQty} onChange={(e) => setF({ ...f, stockQty: e.target.value.replace(/\D/g, '') })} /></label>}
        <p className="muted small">Com estoque ligado, cada pedido dá baixa e o produto fica indisponível ao zerar. Cancelamentos devolvem a quantidade.</p>
      </fieldset>

      {p.id ? (
        <>
          <fieldset className="a-fieldset">
            <legend>Foto</legend>
            <div className="a-row">
              {p.imageUrl ? <img src={p.imageUrl} alt="" className="a-prod-img big" /> : <div className="a-prod-img big empty">sem foto</div>}
              <div>
                <label className="btn btn-secondary btn-sm file-btn">Enviar foto<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></label>
                <p className="muted small">JPG, PNG ou WebP até 8 MB. A imagem é otimizada automaticamente.</p>
              </div>
            </div>
          </fieldset>
          <AddonGroupsEditor productId={p.id} groups={groups} onChanged={reloadGroups} />
        </>
      ) : (
        <p className="alert alert-info">Salve o produto para enviar foto e cadastrar adicionais.</p>
      )}
    </Modal>
  );
}

function AddonGroupsEditor({ productId, groups, onChanged }: { productId: string; groups: Group[]; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [editing, setEditing] = useState<Partial<Group> | null>(null);
  return (
    <fieldset className="a-fieldset">
      <legend>Adicionais e complementos</legend>
      {groups.length === 0 && <p className="muted small">Nenhum grupo. Ex.: "Ponto da carne" (obrigatório, escolha 1) ou "Adicionais" (opcional, até 3).</p>}
      <ul className="a-groups">
        {groups.map((g) => (
          <li key={g.id}>
            <div>
              <strong>{g.name}</strong>
              <span className="muted small"> · {g.minSelect > 0 ? `obrigatório (mín. ${g.minSelect})` : 'opcional'} · máx. {g.maxSelect}</span>
              <div className="muted small">{g.addons.map((a) => `${a.name}${a.priceCents ? ` (+${brl(a.priceCents)})` : ''}${a.available ? '' : ' [indisp.]'}`).join(', ')}</div>
            </div>
            <div className="a-row">
              <button className="btn btn-secondary btn-sm" onClick={() => setEditing(g)}>Editar</button>
              <button className="btn btn-ghost btn-sm" onClick={async () => {
                if (!confirm(`Remover o grupo "${g.name}"?`)) return;
                try { await api(`/api/admin/addon-groups/${g.id}`, { method: 'DELETE' }); await onChanged(); } catch (e) { toast(errorText(e), 'error'); }
              }}>Remover</button>
            </div>
          </li>
        ))}
      </ul>
      <button className="btn btn-secondary btn-sm" onClick={() => setEditing({ name: '', minSelect: 0, maxSelect: 1, addons: [{ name: '', priceCents: 0, available: true }] })}>+ Grupo de adicionais</button>
      {editing && <GroupModal productId={productId} group={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await onChanged(); }} />}
    </fieldset>
  );
}

function GroupModal({ productId, group, onClose, onSaved }: { productId: string; group: Partial<Group>; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(group.name ?? '');
  const [min, setMin] = useState(String(group.minSelect ?? 0));
  const [max, setMax] = useState(String(group.maxSelect ?? 1));
  const [rows, setRows] = useState(() => (group.addons ?? []).map((a) => ({ ...a, price: centsToInput(a.priceCents) })));
  async function save() {
    const addons = rows.filter((r) => r.name.trim()).map((r) => ({ id: r.id, name: r.name.trim(), priceCents: inputToCents(r.price) ?? 0, available: r.available }));
    if (addons.some((a) => Number.isNaN(a.priceCents))) return toast('Preço de adicional inválido.', 'error');
    const body = { name: name.trim(), minSelect: Number(min || 0), maxSelect: Number(max || 1), active: true, addons };
    try {
      if (group.id) await api(`/api/admin/addon-groups/${group.id}`, { method: 'PUT', body });
      else await api(`/api/admin/products/${productId}/addon-groups`, { body });
      toast('Adicionais salvos');
      onSaved();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }
  return (
    <Modal title={group.id ? 'Editar grupo' : 'Novo grupo de adicionais'} onClose={onClose} footer={<button className="btn btn-primary btn-block" onClick={save} disabled={!name.trim()}>Salvar grupo</button>}>
      <label className="field"><span>Nome do grupo</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Ex.: Ponto da carne" /></label>
      <div className="grid-2">
        <label className="field"><span>Mínimo de escolhas</span><input inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value.replace(/\D/g, ''))} /></label>
        <label className="field"><span>Máximo de escolhas</span><input inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ''))} /></label>
      </div>
      <p className="muted small">Mínimo 0 = opcional. Mínimo 1 e máximo 1 = o cliente escolhe exatamente uma opção.</p>
      <table className="a-table">
        <thead><tr><th>Opção</th><th>Preço (R$)</th><th>Disp.</th><th /></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td><input value={r.name} maxLength={60} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label="Nome da opção" /></td>
              <td><input inputMode="decimal" value={r.price} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} aria-label="Preço" placeholder="0,00" /></td>
              <td><input type="checkbox" checked={r.available} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, available: e.target.checked } : x)))} aria-label="Disponível" /></td>
              <td><button className="btn btn-ghost btn-sm" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remover opção">✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn btn-secondary btn-sm" onClick={() => setRows([...rows, { name: '', priceCents: 0, price: '', available: true }])}>+ Opção</button>
    </Modal>
  );
}
