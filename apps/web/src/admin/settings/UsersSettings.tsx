import { useEffect, useState } from 'react';
import { api, formatDateTime } from '../../lib/api';
import { ROLE_LABELS, useSession, type AdminUser } from '../session';
import { Modal, Toggle, errorText, useToast } from '../ui';

interface UserRow extends AdminUser { active: boolean; last_login_at: string | null }

export function UsersSettings() {
  const { user } = useSession();
  const toast = useToast();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [edit, setEdit] = useState<Partial<UserRow> | null>(null);
  const load = () => api<{ users: UserRow[] }>('/api/admin/users').then((r) => setUsers(r.users)).catch((e) => toast(errorText(e), 'error'));
  useEffect(() => { load(); }, []);
  if (user.role !== 'owner') return <p className="alert alert-info">Somente o dono gerencia usuários.</p>;
  return (
    <div>
      <div className="a-section-head">
        <h2>Usuários</h2>
        <button className="btn btn-primary btn-sm" onClick={() => setEdit({ name: '', email: '', role: 'staff', active: true })}>+ Usuário</button>
      </div>
      <p className="muted small">Dono: tudo, inclusive usuários. Gerente: cardápio, entrega, impressora, cancelamentos. Atendente: pedidos, esgotar produto e imprimir.</p>
      <table className="a-table">
        <thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Último acesso</th><th /></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className={u.active ? '' : 'inactive'}>
              <td>{u.name}{!u.active && ' (inativo)'}</td>
              <td>{u.email}</td>
              <td>{ROLE_LABELS[u.role]}</td>
              <td>{u.last_login_at ? formatDateTime(u.last_login_at) : '—'}</td>
              <td><button className="btn btn-secondary btn-sm" onClick={() => setEdit(u)}>Editar</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && <UserModal u={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </div>
  );
}

function UserModal({ u, onClose, onSaved }: { u: Partial<UserRow>; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: u.name ?? '', email: u.email ?? '', role: u.role ?? 'staff', active: u.active ?? true, password: '' });
  async function save() {
    try {
      if (u.id) await api(`/api/admin/users/${u.id}`, { method: 'PUT', body: { name: f.name, role: f.role, active: f.active, ...(f.password ? { password: f.password } : {}) } });
      else await api('/api/admin/users', { body: f });
      toast('Usuário salvo');
      onSaved();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }
  return (
    <Modal title={u.id ? 'Editar usuário' : 'Novo usuário'} onClose={onClose} footer={<button className="btn btn-primary btn-block" onClick={save}>Salvar</button>}>
      <label className="field"><span>Nome</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} /></label>
      <label className="field"><span>E-mail</span><input type="email" value={f.email} disabled={!!u.id} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
      <label className="field"><span>Perfil</span>
        <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as UserRow['role'] })}>
          <option value="staff">Atendente</option><option value="manager">Gerente</option><option value="owner">Dono</option>
        </select>
      </label>
      <label className="field"><span>{u.id ? 'Nova senha (deixe vazio para manter)' : 'Senha inicial'}</span>
        <input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        <span className="hint">Mínimo 10 caracteres, com letras e números. Trocar a senha encerra as sessões abertas do usuário.</span>
      </label>
      {u.id && <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Acesso ativo" />}
    </Modal>
  );
}
