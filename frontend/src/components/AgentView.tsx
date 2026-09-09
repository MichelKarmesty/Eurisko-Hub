import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiClaimTicket, apiListTickets, apiCreateTicket } from '../api';
import type { Category, Priority, Ticket } from '../types';
import { CATEGORIES, PRIORITIES } from '../types';
import { ResolveControl } from './ResolveControl';
import { TicketTable } from './TicketTable';
import { Notice, Spinner, StatusBadge } from './ui';

/**
 * Support Agent workspace.
 *
 * Tabs:
 *  1. Queue     — claim Open tickets from the agent's department (ADR-001).
 *  2. Submit    — open a ticket for any department (api.md: POST /tickets is
 *                 available to "any authenticated user").
 *
 * The agent claims an Open ticket which moves it to In Progress, then uses
 * <ResolveControl /> to send PATCH /tickets/:id/status { status:'Resolved', resolutionNote }.
 */

type Tab = 'queue' | 'submit';

// ---------------------------------------------------------------------------
// Queue tab
// ---------------------------------------------------------------------------

function QueueTab({ user }: { user: { id: number; name: string } }) {
  const [queue, setQueue] = useState<Ticket[]>([]);
  const [mine, setMine] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [claimingId, setClaimingId] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [q, m] = await Promise.all([
        apiListTickets(),           // agent: OPEN tickets in their department queue
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

  useEffect(() => { void load(); }, [load]);

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

// ---------------------------------------------------------------------------
// Submit ticket tab (api.md: POST /tickets — any authenticated user)
// ---------------------------------------------------------------------------

function SubmitTab() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<Category>('IT');
  const [priority, setPriority] = useState<Priority>('Medium');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [myTickets, setMyTickets] = useState<Ticket[]>([]);
  const [loadingTickets, setLoadingTickets] = useState(true);

  const loadMyTickets = useCallback(async () => {
    try {
      // fetch tickets submitted BY this agent (requester_id = me)
      // backend returns requester-scoped list when called without filters on agent role
      // we use a workaround: pass mine=true which returns tickets the agent submitted
      const all = await apiListTickets();
      setMyTickets(all);
    } catch {
      // non-critical — just leave empty
    } finally {
      setLoadingTickets(false);
    }
  }, []);

  useEffect(() => { void loadMyTickets(); }, [loadMyTickets]);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitting(true);
    setNotice(null);
    try {
      const created = await apiCreateTicket({ title, description, category, priority });
      setMyTickets((prev) => [created, ...prev]);
      setTitle('');
      setDescription('');
      setNotice({ kind: 'success', text: `Ticket #${created.id} submitted to ${created.category} — status "${created.status}".` });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to submit the ticket.' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="stack">
      <Notice kind={notice?.kind ?? 'info'}>{notice?.text}</Notice>

      <section className="card">
        <h2>Submit a request</h2>
        <p className="muted small">
          Need help from another department? Open a ticket and the right team will pick it up.
        </p>
        <form className="grid-form" onSubmit={(e) => void submit(e)}>
          <label>
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              minLength={3}
              placeholder="Brief description of the issue"
            />
          </label>
          <label>
            Category
            <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          <label>
            Priority
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
            </select>
          </label>
          <label className="full">
            Description
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              minLength={3}
              rows={3}
              placeholder="Describe the problem in detail"
            />
          </label>
          <div className="full">
            <button className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit ticket'}
            </button>
          </div>
        </form>
      </section>

      <section className="card">
        <h2>My submitted requests</h2>
        {loadingTickets ? (
          <Spinner />
        ) : (
          <TicketTable tickets={myTickets} empty="You have not submitted any requests yet." />
        )}
        <button className="btn btn-ghost" onClick={() => void loadMyTickets()}>
          Refresh
        </button>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentView — tabbed shell
// ---------------------------------------------------------------------------

export function AgentView({ user }: { user: { id: number; name: string } }) {
  const [tab, setTab] = useState<Tab>('queue');

  return (
    <div className="stack">
      <nav className="tab-bar">
        <button
          className={`tab-btn${tab === 'queue' ? ' tab-btn--active' : ''}`}
          onClick={() => setTab('queue')}
        >
          🎫 My Queue
        </button>
        <button
          className={`tab-btn${tab === 'submit' ? ' tab-btn--active' : ''}`}
          onClick={() => setTab('submit')}
        >
          ✉️ Submit a Request
        </button>
      </nav>

      {tab === 'queue' ? <QueueTab user={user} /> : <SubmitTab />}
    </div>
  );
}
