import { useEffect, useRef } from 'react';
import type { JSX, ReactNode } from 'react';

export function Loading({ label = 'Loading…' }: { label?: string }): JSX.Element {
  return (
    <div className="state card" role="status" aria-live="polite">
      <div className="spinner" />
      <div className="muted">{label}</div>
    </div>
  );
}

/**
 * A shimmer-free, calm table skeleton that mirrors the real grid's silhouette
 * so panels never flash an empty box while rows load. Solid fills only.
 */
export function TableSkeleton({
  columns = 5,
  rows = 6,
  label = 'Loading…',
}: {
  columns?: number;
  rows?: number;
  label?: string;
}): JSX.Element {
  const cols = Array.from({ length: columns });
  const lines = Array.from({ length: rows });
  return (
    <div
      className="table-scroll skeleton"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <table className="grid" aria-hidden="true">
        <thead>
          <tr>
            {cols.map((_, i) => (
              <th key={i}>
                <span className="sk sk-head" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((_, r) => (
            <tr key={r}>
              {cols.map((_, c) => (
                <td key={c}>
                  <span
                    className="sk sk-cell"
                    style={{ width: `${52 + ((r * 7 + c * 13) % 40)}%` }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }): JSX.Element {
  return (
    <div className="error-banner" role="alert">
      {message}
    </div>
  );
}

export function OkBanner({ message }: { message: string }): JSX.Element {
  return (
    <div className="ok-banner" role="status">
      {message}
    </div>
  );
}

/**
 * A transient success toast that auto-dismisses. Used for confirmations
 * (row saved, key revoked) so the message never lingers on screen.
 */
export function Toast({
  message,
  onClose,
  duration = 3200,
}: {
  message: string;
  onClose: () => void;
  duration?: number;
}): JSX.Element {
  useEffect(() => {
    const t = window.setTimeout(onClose, duration);
    return () => window.clearTimeout(t);
  }, [message, duration, onClose]);

  return (
    <div className="toast" role="status" aria-live="polite">
      <span className="toast-tick" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12l4.5 4.5L19 7" />
        </svg>
      </span>
      <span className="toast-msg">{message}</span>
      <button className="toast-x" onClick={onClose} aria-label="Dismiss">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

export function Empty({
  title,
  hint,
  icon,
  action,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="state card">
      <div className="empty-mark" aria-hidden="true">
        {icon ?? (
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 9h18M9 9v11" />
          </svg>
        )}
      </div>
      <h3>{title}</h3>
      {hint ? <p className="muted">{hint}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

/** Accessible modal with focus management and Escape-to-close. */
export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
      >
        <div className="modal-head">
          <h2>{title}</h2>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}
