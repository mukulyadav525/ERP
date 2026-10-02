import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

type Tone = 'good' | 'critical' | 'info';
interface ToastAction { label: string; onClick: () => void }
interface Toast { id: number; tone: Tone; title: string; message?: string; action?: ToastAction }

interface ToastCtx {
  toast: (title: string, opts?: { message?: string; tone?: Tone; action?: ToastAction }) => void;
  success: (title: string, message?: string) => void;
  error: (err: unknown, fallback?: string) => void;
}

const Ctx = createContext<ToastCtx | undefined>(undefined);
let nextId = 1;

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((title: string, opts: { message?: string; tone?: Tone; action?: ToastAction } = {}) => {
    const t: Toast = { id: nextId++, tone: opts.tone ?? 'info', title, message: opts.message, action: opts.action };
    setToasts((list) => [...list, t]);
    // Errors stay on screen longer, because they usually need reading twice; one
    // with an action (Undo) long enough to reach for it.
    setTimeout(() => dismiss(t.id), t.tone === 'critical' ? 7000 : t.action ? 8000 : 4000);
  }, [dismiss]);

  const success = useCallback((title: string, message?: string) => {
    toast(title, { message, tone: 'good' });
  }, [toast]);

  /** Takes whatever was thrown and shows the server's own wording, which is
   *  written for the person at the counter rather than for a developer. */
  const error = useCallback((err: unknown, fallback = 'Something went wrong.') => {
    const message = err instanceof Error && err.message ? err.message : fallback;
    toast(message, { tone: 'critical' });
  }, [toast]);

  const value = useMemo(() => ({ toast, success, error }), [toast, success, error]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            <span aria-hidden>{t.tone === 'good' ? '✓' : t.tone === 'critical' ? '⚠' : 'ℹ'}</span>
            <div className="body">
              <b>{t.title}</b>
              {t.message && <span className="muted small">{t.message}</span>}
            </div>
            {t.action && (
              <button className="btn sm" onClick={() => { t.action!.onClick(); dismiss(t.id); }}>{t.action.label}</button>
            )}
            <button className="close" onClick={() => dismiss(t.id)} aria-label="Dismiss">×</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
};

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
