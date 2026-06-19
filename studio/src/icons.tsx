// Lean inline icon set (stroke icons matching the landing's visual language).
import type { JSX } from 'react';

type P = { className?: string };
const base = (children: JSX.Element): ((p: P) => JSX.Element) => {
  return ({ className }: P) => (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
};

export const IconDashboard = base(
  <>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </>,
);

export const IconTable = base(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18M3 14h18M9 4v16" />
  </>,
);

export const IconSql = base(
  <>
    <path d="M4 6h16M4 12h16M4 18h10" />
    <path d="M17 16l3 2-3 2" />
  </>,
);

export const IconUsers = base(
  <>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.2a3 3 0 0 1 0 5.6M17.5 20a5.5 5.5 0 0 0-3-4.9" />
  </>,
);

export const IconStorage = base(
  <>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
    <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
  </>,
);

export const IconShield = base(
  <>
    <path d="M12 2l8 3v6c0 5-3.4 8.5-8 11-4.6-2.5-8-6-8-11V5z" />
    <path d="M9 12l2 2 4-4" />
  </>,
);

export const IconSignOut = base(
  <>
    <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
    <path d="M9 12h11M16 8l4 4-4 4" />
  </>,
);

export const IconPlus = base(<path d="M12 5v14M5 12h14" />);
export const IconTrash = base(
  <>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
  </>,
);
export const IconEdit = base(
  <>
    <path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
    <path d="M13.5 6.5l3 3" />
  </>,
);

export function BrandMark({ size = 28 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7" fill="#0F2A1D" />
      <path
        d="M9 22 L16 8 L23 22"
        fill="none"
        stroke="#E0A93B"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="22" r="2.1" fill="#E0A93B" />
    </svg>
  );
}
