import { Component, StrictMode, Suspense, lazy, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import { CardapioApp } from './cardapio/CardapioApp';

const AdminApp = lazy(() => import('./admin/AdminApp'));

// Falha inesperada na tela: mostra aviso com opção de recarregar em vez de página em branco.
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page-loading" role="alert">
        <p>Algo deu errado ao carregar esta tela.</p>
        <button className="btn btn-primary" onClick={() => location.reload()}>Recarregar</button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
      <Suspense fallback={<div className="page-loading">Carregando…</div>}>
        <Routes>
          <Route path="/cardapio/*" element={<CardapioApp />} />
          <Route path="/admin/*" element={<AdminApp />} />
          <Route path="*" element={<Navigate to="/cardapio" replace />} />
        </Routes>
      </Suspense>
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
);
