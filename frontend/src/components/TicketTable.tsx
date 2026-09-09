import { useState, type ReactNode } from 'react';
import { apiTicketHistory } from '../api';
import type { Ticket, TicketEvent } from '../types';
import { StatusBadge } from './ui';

function fmt(d: string | undefined | null): string {
  return d ? new Date(d).toLocaleString() : '—';
}

const ACTION_LABEL: Record<TicketEvent['action'], string> = {
  CREATED: 'Created',
  CLAIMED: 'Claimed',
  STATUS_CHANGED: 'Status changed',
  RESOLVED: 'Resolved',
};

/**
 * One shared ticket table. The `actions` cell is where the current user's
 * React action (claim / resolve / advance) is injected per role.
 *
 * Every row also offers a small "History" toggle that loads the durable event
 * log (GET /tickets/:id/history) so anyone can see WHO did WHAT and WHEN —
 * including who resolved the ticket, with their note.
 */
export function TicketTable({
  tickets,
  actions,
  empty,
}: {
  tickets: Ticket[];
  actions?: (t: Ticket) => ReactNode;
  empty?: string;
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [history, setHistory] = useState<Record<number, TicketEvent[]>>({});
  const [historyError, setHistoryError] = useState<Record<number, string>>({});
  const [loadingId, setLoadingId] = useState<number | null>(null);

  const toggle = async (t: Ticket) => {
    if (expandedId === t.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(t.id);
    if (!history[t.id] && !historyError[t.id]) {
      setLoadingId(t.id);
      try {
        const evs = (await apiTicketHistory(t.id)) as TicketEvent[];
        setHistory((prev) => ({ ...prev, [t.id]: evs }));
      } catch (err) {
        setHistoryError((prev) => ({
          ...prev,
          [t.id]: err instanceof Error ? err.message : 'Could not load history.',
        }));
      } finally {
        setLoadingId(null);
      }
    }
  };

  if (tickets.length === 0) {
    return <p className="muted">{empty ?? 'No tickets.'}</p>;
  }

  const cols = 9 + (actions ? 1 : 0);

  return (
    <div className="table-wrap">
      <table className="tickets">
        <thead>
          <tr>
            <th>#</th>
            <th>Title</th>
            <th>Category</th>
            <th>Priority</th>
            <th>Status</th>
            <th>Requester</th>
            <th>Assigned to</th>
            <th>Resolution note</th>
            <th>Updated</th>
            {actions ? <th>Action</th> : null}
          </tr>
        </thead>
        <tbody>
          {tickets.map((t) => {
            const isOpen = expandedId === t.id;
            const events = history[t.id];
            const resolvedBy = t.status === 'Resolved' ? (t.assignedTo?.name ?? null) : null;
            return (
              <TicketRowGroup
                key={t.id}
                ticket={t}
                cols={cols}
                actions={actions}
                isOpen={isOpen}
                loading={loadingId === t.id}
                events={events}
                error={historyError[t.id]}
                resolvedBy={resolvedBy}
                onToggle={() => void toggle(t)}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TicketRowGroup({
  ticket: t,
  cols,
  actions,
  isOpen,
  loading,
  events,
  error,
  resolvedBy,
  onToggle,
}: {
  ticket: Ticket;
  cols: number;
  actions?: (t: Ticket) => ReactNode;
  isOpen: boolean;
  loading: boolean;
  events?: TicketEvent[];
  error?: string;
  resolvedBy: string | null;
  onToggle: () => void;
}) {
  return (
    <>
      <tr>
        <td>{t.id}</td>
        <td>
          <strong>{t.title}</strong>
          <div className="muted small">{t.description}</div>
          <button type="button" className="history-toggle" onClick={onToggle}>
            {isOpen ? '▴ Hide history' : '▾ History'}
          </button>
        </td>
        <td>{t.category}</td>
        <td>{t.priority}</td>
        <td>
          <StatusBadge status={t.status} />
        </td>
        <td>{t.requester?.name ?? `#${t.requesterId}`}</td>
        <td>{t.assignedTo ? t.assignedTo.name : '—'}</td>
        <td className="small">
          {t.resolutionNote ?? '—'}
          {resolvedBy && (
            <div className="muted small">
              ✅ Resolved by <strong>{resolvedBy}</strong>
            </div>
          )}
        </td>
        <td className="muted small">{fmt(t.updatedAt)}</td>
        {actions ? <td>{actions(t)}</td> : null}
      </tr>
      {isOpen && (
        <tr className="history-row">
          <td colSpan={cols}>
            {loading ? (
              <span className="muted small">Loading history…</span>
            ) : error ? (
              <span className="muted small">History unavailable — {error}</span>
            ) : events && events.length > 0 ? (
              <ul className="history-list">
                {events.map((e) => (
                  <li key={e.id} className="history-event">
                    <span className="history-action">{ACTION_LABEL[e.action]}</span>
                    {e.fromStatus && e.toStatus && e.fromStatus !== e.toStatus && (
                      <span className="muted small">
                        {e.fromStatus} → {e.toStatus}
                      </span>
                    )}
                    <span className="muted small">
                      by {e.actor?.name ?? `#${e.actorId}`} · {fmt(e.createdAt)}
                    </span>
                    {e.note && <span className="muted small history-note">“{e.note}”</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="muted small">No history recorded for this ticket.</span>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
