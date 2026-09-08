import type { ReactNode } from 'react';
import type { Ticket } from '../types';
import { StatusBadge } from './ui';

function fmt(d: string | undefined | null): string {
  return d ? new Date(d).toLocaleString() : '—';
}

/**
 * One shared ticket table. The `actions` cell is where the current user's
 * React action (claim / resolve / advance) is injected per role.
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
  if (tickets.length === 0) {
    return <p className="muted">{empty ?? 'No tickets.'}</p>;
  }
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
          {tickets.map((t) => (
            <tr key={t.id}>
              <td>{t.id}</td>
              <td>
                <strong>{t.title}</strong>
                <div className="muted small">{t.description}</div>
              </td>
              <td>{t.category}</td>
              <td>{t.priority}</td>
              <td>
                <StatusBadge status={t.status} />
              </td>
              <td>{t.requester?.name ?? `#${t.requesterId}`}</td>
              <td>{t.assignedTo ? t.assignedTo.name : '—'}</td>
              <td className="small">{t.resolutionNote ?? '—'}</td>
              <td className="muted small">{fmt(t.updatedAt)}</td>
              {actions ? <td>{actions(t)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
