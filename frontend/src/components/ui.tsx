import type { ReactNode } from 'react';

export function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'Open'
      ? 'badge-open'
      : status === 'In Progress'
        ? 'badge-progress'
        : 'badge-resolved';
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function Notice({
  kind,
  children,
}: {
  kind: 'error' | 'success' | 'info';
  children: ReactNode;
}) {
  if (!children) return null;
  return <div className={`notice notice-${kind}`}>{children}</div>;
}

export function Spinner() {
  return <div className="spinner" aria-label="Loading" />;
}
