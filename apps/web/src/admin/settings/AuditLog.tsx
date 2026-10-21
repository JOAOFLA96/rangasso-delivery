import { useEffect, useState } from 'react';
import { api, formatDateTime } from '../../lib/api';

interface Entry { id: number; action: string; entity: string; entity_id: string; data: any; created_at: string; user_name: string | null; device_name: string | null }

const ACTIONS: Record<string, string> = {
  'auth.login': 'Entrou no painel', 'auth.logout': 'Saiu do painel', 'auth.login_failed': 'Senha errada no login',
  'order.status': 'Mudou status de pedido', 'print.reprint': 'Reimprimiu comanda', 'print.manual': 'Imprimiu comanda',
  'print.test': 'Impressão de teste', 'print.retry': 'Repetiu impressão', 'print.mark_printed': 'Marcou como impresso', 'print.cancel': 'Cancelou impressão',
  'product.create': 'Criou produto', 'product.update': 'Editou produto', 'product.archive': 'Excluiu produto', 'product.availability': 'Mudou disponibilidade',
  'product.image': 'Trocou foto', 'product.reorder': 'Reordenou produtos', 'category.create': 'Criou categoria', 'category.update': 'Editou categoria',
  'category.archive': 'Excluiu categoria', 'category.reorder': 'Reordenou categorias', 'addon_group.create': 'Criou adicionais', 'addon_group.update': 'Editou adicionais',
  'addon_group.disable': 'Removeu adicionais', 'neighborhood.create': 'Criou bairro', 'neighborhood.update': 'Editou bairro/taxa',
  'settings.store': 'Editou dados da loja', 'settings.delivery': 'Editou regras de entrega', 'settings.printer': 'Editou impressora', 'settings.hours': 'Editou horários',
  'settings.logo': 'Trocou a logo', 'closure.upsert': 'Cadastrou exceção', 'closure.delete': 'Removeu exceção', 'device.create': 'Criou credencial de agente',
  'device.revoke': 'Revogou agente', 'user.create': 'Criou usuário', 'user.update': 'Editou usuário', 'user.password_change': 'Trocou a própria senha',
};

export function AuditLog() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [filter, setFilter] = useState('');
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const p = new URLSearchParams({ limit: '100', offset: String(offset) });
    if (filter) p.set('action', filter);
    api<{ entries: Entry[] }>(`/api/admin/audit?${p}`).then((r) => setEntries(r.entries));
  }, [filter, offset]);
  return (
    <div>
      <h2>Auditoria</h2>
      <p className="muted small">Registro das ações administrativas: quem fez, o quê e quando.</p>
      <select value={filter} onChange={(e) => { setFilter(e.target.value); setOffset(0); }} style={{ maxWidth: 280 }} aria-label="Filtrar">
        <option value="">Todas as ações</option>
        <option value="order">Pedidos</option><option value="print">Impressão</option><option value="product">Produtos</option>
        <option value="neighborhood">Bairros</option><option value="settings">Configurações</option><option value="user">Usuários</option><option value="auth">Acessos</option>
      </select>
      <table className="a-table">
        <thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Detalhe</th></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td>{formatDateTime(e.created_at)}</td>
              <td>{e.user_name ?? e.device_name ?? '—'}</td>
              <td>{ACTIONS[e.action] ?? e.action}</td>
              <td className="small muted">{summary(e)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="a-row">
        <button className="btn btn-secondary btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Anteriores</button>
        <button className="btn btn-secondary btn-sm" disabled={entries.length < 100} onClick={() => setOffset(offset + 100)}>Mais antigos</button>
      </div>
    </div>
  );
}

function summary(e: Entry) {
  const d = e.data ?? {};
  if (e.action === 'order.status') return `${d.from} → ${d.to}${d.note ? ` (${d.note})` : ''}`;
  if (d.after?.name) return d.after.name;
  if (d.name) return d.name;
  if (d.reason) return `Motivo: ${d.reason}`;
  return '';
}
