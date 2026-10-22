import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { SessionCtx, ROLE_LABELS, type AdminUser } from './session';
import { ToastProvider } from './ui';
import { OrdersTab } from './OrdersTab';
import { SettingsTab } from './settings/SettingsTab';
import { ReviewsTab } from './ReviewsTab';
import '../admin.css';

export default function AdminApp() {
  const [user, setUser] = useState<AdminUser | null | undefined>(undefined);
  const navigate = useNavigate();

  useEffect(() => {
    document.title = 'Painel — Rangasso';
    api<{ user: AdminUser }>('/api/auth/me').then((r) => setUser(r.user)).catch(() => setUser(null));
  }, []);

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    navigate('/admin/login');
  }, [navigate]);

  if (user === undefined) return <div className="page-loading">Carregando…</div>;
  if (!user) {
    return (
      <Routes>
        <Route path="login" element={<Login onLogin={(u) => { setUser(u); navigate('/admin'); }} />} />
        <Route path="*" element={<Navigate to="/admin/login" replace />} />
      </Routes>
    );
  }

  return (
    <SessionCtx.Provider value={{ user, logout }}>
      <ToastProvider>
        <div className="a-shell">
          <header className="a-top">
            <img src="/brand/logo-rangasso-trim.png" alt="Rangasso" className="a-logo" />
            <nav className="a-tabs" aria-label="Seções">
              <NavLink to="/admin/pedidos">Pedidos</NavLink>
              <NavLink to="/admin/avaliacoes">Avaliações</NavLink>
              <NavLink to="/admin/configuracoes">Configurações</NavLink>
            </nav>
            <div className="a-user">
              <span className="a-user-name">{user.name} · {ROLE_LABELS[user.role]}</span>
              <button className="btn btn-secondary btn-sm" onClick={logout}>Sair</button>
            </div>
          </header>
          <Routes>
            <Route path="pedidos/*" element={<OrdersTab />} />
            <Route path="avaliacoes" element={<ReviewsTab />} />
            <Route path="configuracoes/*" element={<SettingsTab />} />
            <Route path="*" element={<Navigate to="/admin/pedidos" replace />} />
          </Routes>
        </div>
      </ToastProvider>
    </SessionCtx.Provider>
  );
}

function Login({ onLogin }: { onLogin: (u: AdminUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ user: AdminUser }>('/api/auth/login', { body: { email, password } });
      onLogin(r.user);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="a-login">
      <form className="card a-login-card" onSubmit={submit}>
        <img src="/brand/logo-rangasso-trim.png" alt="Rangasso" className="a-login-logo" />
        <h1>Painel do delivery</h1>
        <label className="field"><span>E-mail</span><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label className="field"><span>Senha</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
        <p className="muted small">Esqueceu a senha? Peça ao dono da conta para redefinir em Configurações › Usuários.</p>
      </form>
    </div>
  );
}
