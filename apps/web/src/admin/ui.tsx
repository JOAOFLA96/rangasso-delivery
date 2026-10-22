import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';

// Componentes básicos do painel: modal, avisos (toast) e campos.

export function Modal({ title, onClose, children, footer, wide = false }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div className={`sheet a-modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onMouseDown={(e) => e.stopPropagation()}>
        <div className="a-modal-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Fechar">✕</button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-footer">{footer}</div>}
      </div>
    </div>
  );
}

interface Toast { id: number; text: string; kind: 'ok' | 'error' | 'info' }
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast toast-${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function errorText(e: unknown) {
  const err = e as ApiError;
  const fields = err?.details?.fields as { field: string; message: string }[] | undefined;
  if (fields?.length) return `${err.message} (${fields.map((f) => `${f.field}: ${f.message}`).join('; ')})`;
  return err?.message ?? 'Erro inesperado.';
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="toggle">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

export function Confirm({ title, text, confirmLabel, danger, onConfirm, onClose, requireReason, reasonOptional }: {
  title: string; text: string; confirmLabel: string; danger?: boolean; requireReason?: string; reasonOptional?: boolean;
  onConfirm: (reason: string) => Promise<void> | void; onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} footer={
      <>
        <button className="btn btn-secondary" onClick={onClose}>Voltar</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'} btn-grow`} disabled={busy || (requireReason !== undefined && !reasonOptional && !reason.trim())}
          onClick={async () => { setBusy(true); try { await onConfirm(reason.trim()); onClose(); } finally { setBusy(false); } }}>
          {busy ? 'Aguarde…' : confirmLabel}
        </button>
      </>
    }>
      <p>{text}</p>
      {requireReason !== undefined && (
        <label className="field">
          <span>{requireReason || 'Motivo'}</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={2} autoFocus />
        </label>
      )}
    </Modal>
  );
}
