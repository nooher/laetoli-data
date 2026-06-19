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

export function Empty({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}): JSX.Element {
  return (
    <div className="state card">
      <h3>{title}</h3>
      {hint ? <p className="muted">{hint}</p> : null}
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
