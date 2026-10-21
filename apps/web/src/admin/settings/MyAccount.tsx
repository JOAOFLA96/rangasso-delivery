import { useState } from 'react';
import { api } from '../../lib/api';
import { ROLE_LABELS, useSession } from '../session';
import { errorText, useToast } from '../ui';

export function MyAccount() {
  const { user } = useSession();
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  async function save() {
    if (next !== confirm) return toast('A confirmação não confere.', 'error');
    try {
      await api('/api/admin/me/password', { body: { currentPassword: cur, newPassword: next } });
      toast('Senha alterada. Outras sessões foram encerradas.');
      setCur(''); setNext(''); setConfirm('');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }
  return (
    <div>
      <h2>Minha conta</h2>
      <section className="card">
        <p><strong>{user.name}</strong> · {user.email} · {ROLE_LABELS[user.role]}</p>
        <h3>Trocar senha</h3>
        <label className="field"><span>Senha atual</span><input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></label>
        <label className="field"><span>Nova senha</span><input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /><span className="hint">Mínimo 10 caracteres, com letras e números.</span></label>
        <label className="field"><span>Repita a nova senha</span><input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
        <button className="btn btn-primary" disabled={!cur || !next} onClick={save}>Salvar nova senha</button>
      </section>
    </div>
  );
}
