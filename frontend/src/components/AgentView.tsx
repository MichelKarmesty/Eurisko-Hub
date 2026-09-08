import { useCallback, useEffect, useState } from 'react';
import { apiClaimTicket, apiListTickets } from '../api';
import type { Ticket } from '../types';
import { ResolveControl } from './ResolveControl';
import { TicketTable } from './TicketTable';
import { Notice, Spinner, StatusBadge } from './ui';

/**
 * Support Agent workspace — this is where the slice's "React action" lives.
 *
 * The agent claims an Open ticket from the department queue (ADR-001), which
 * moves it to In Progress, then uses <ResolveControl /> to send
 *   PATCH /tickets/:id/status { status: 'Resolved', resolutionNote }
 * On success the updated ticket from the response replaces the old one in
 * local state, so the ticket *visibly moves* from the "In Progress" section
 * into the "Resolved" section with its note shown — immediately.
 */
export function AgentView({ user }: { user: { id: number; name: string } }) {
  const [queue, setQueue] = useState<Ticket[]>([]);
  const [mine, setMine] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [claimingId, setClaimingId] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [q, m] = await Promise.all([
        apiListTickets(), // agent: OPEN tickets in their department queue
        apiListTickets({ mine: true }), // tickets this agent claimed
      ]);
      setQueue(q);
      setMine(m);
      setNotice(null);
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not load the queue.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const claim = async (t: Ticket) => {
    setClaimingId(t.id);
    setNotice(null);
    try {
      const claimed = await apiClaimTicket(t.id); // Open -> In Progress
      setQueue((prev) => prev.filter((x) => x.id !== t.id));
      setMine((prev) => [claimed, ...prev]);
      setNotice({ kind: 'success', text: `Claimed ticket #${claimed.id} — it is now In Progress.` });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not claim the ticket.' });
    } finally {
      setClaimingId(null);
    }
  };

  /** The authoritative response replaces the old ticket -> UI updates instantly. */
  const handleResolved = (updated: Ticket) => {
    setMine((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    setNotice({ kind: 'success', text: `Ticket #${updated.id} resolved.` });
  };

  const inProgress = mine.filter((t) => t.status === 'In Progress');
  const resolved = mine
    .filter((t) => t.status === 'Resolved')
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

  if (loading) return <Spinner />;

  return (
    <div className="stack">
      <p className="muted">
        Signed in as {user.name} — you can serve tickets in your department queue.
      </p>
      <Notice kind={notice?.kind ?? 'info'}>{notice?.text}</Notice>

      <section className="card">
        <h2>Department queue · Open ({queue.length})</h2>
        <TicketTable
          tickets={queue}
          empty="Nothing waiting in your queue."
          actions={(t) => (
            <button className="btn" disabled={claimingId === t.id} onClick={() => void claim(t)}>
              {claimingId === t.id ? 'Claiming…' : 'Claim'}
            </button>
          )}
        />
      </section>

      <section className="card">
        <h2>My work · In Progress ({inProgress.length})</h2>
        {inProgress.length === 0 ? (
          <p className="muted">Claim an Open ticket above to start working on it.</p>
        ) : (
          <div className="work-list">
            {inProgress.map((t) => (
              <article className="work-item" key={t.id}>
                <header>
                  <span className="work-title">
                    #{t.id} — {t.title}
                  </span>
                  <StatusBadge status={t.status} />
                </header>
                <p className="muted small">{t.description}</p>
                <p className="muted small">
                  {t.category} · {t.priority} priority · opened by {t.requester?.name}
                </p>
                {/* THE SLICE ACTION */}
                <ResolveControl ticket={t} onResolved={handleResolved} />
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Resolved by me ({resolved.length})</h2>
        <TicketTable tickets={resolved} empty="Nothing resolved yet." />
      </section>

      <button className="btn btn-ghost" onClick={() => void load()}>
        Refresh queue
      </button>
    </div>
  );
}
