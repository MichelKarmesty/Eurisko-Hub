import { useCallback, useEffect, useState } from 'react';
import { apiListTickets, apiUpdateStatus } from '../api';
import type { AdminStats, Ticket } from '../types';
import { ResolveControl } from './ResolveControl';
import { TicketTable } from './TicketTable';
import { Notice, Spinner } from './ui';

function computeStats(tickets: Ticket[]): AdminStats {
  const byStatus: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const t of tickets) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    byCategory[t.category] = (byCategory[t.category] ?? 0) + 1;
  }
  return {
    total: tickets.length,
    byStatus,
    byCategory,
    openUnclaimed: tickets.filter((t) => t.status === 'Open' && t.assignedToId == null).length,
    highPriorityOpen: tickets.filter((t) => t.status === 'Open' && t.priority === 'High').length,
  };
}

/**
 * Admin dashboard: every ticket company-wide (product-spec §3). Admin shares
 * the agent's authority to advance the lifecycle, one step at a time.
 */
export function AdminView() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setTickets(await apiListTickets());
      setNotice(null);
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not load tickets.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = (updated: Ticket) =>
    setTickets((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));

  const start = async (t: Ticket) => {
    setBusyId(t.id);
    try {
      const updated = await apiUpdateStatus(t.id, { status: 'In Progress' });
      replace(updated);
      setNotice({ kind: 'success', text: `Ticket #${t.id} is now In Progress.` });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Action failed.' });
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <Spinner />;

  const stats = computeStats(tickets);
  return (
    <div className="stack">
      <Notice kind={notice?.kind ?? 'info'}>{notice?.text}</Notice>

      <section className="stat-row">
        <div className="stat">
          <span className="stat-num">{stats.total}</span>
          <span>Total tickets</span>
        </div>
        <div className="stat">
          <span className="stat-num">{stats.openUnclaimed}</span>
          <span>Open &amp; unclaimed</span>
        </div>
        <div className="stat">
          <span className="stat-num">{stats.highPriorityOpen}</span>
          <span>High priority open</span>
        </div>
        <div className="stat">
          <span className="stat-num">{stats.byStatus['Resolved'] ?? 0}</span>
          <span>Resolved</span>
        </div>
      </section>

      <section className="card">
        <h2>All tickets ({stats.total})</h2>
        <TicketTable
          tickets={tickets}
          empty="No tickets in the system."
          actions={(t) => {
            if (t.status === 'Open') {
              return (
                <button className="btn" disabled={busyId === t.id} onClick={() => void start(t)}>
                  {busyId === t.id ? '…' : 'Start (In Progress)'}
                </button>
              );
            }
            if (t.status === 'In Progress') {
              return <ResolveControl ticket={t} onResolved={replace} />;
            }
            return <span className="muted">—</span>;
          }}
        />
      </section>

      <button className="btn btn-ghost" onClick={() => void load()}>
        Refresh
      </button>
    </div>
  );
}
