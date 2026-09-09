import { useCallback, useEffect, useState } from 'react';
import {
  apiListTickets,
  apiUpdateStatus,
  apiListUsers,
  apiCreateUser,
  apiPatchUserRole,
} from '../api';
import type { AdminStats, Ticket, User } from '../types';
import { ROLES, type Role } from '../types';
import { ResolveControl } from './ResolveControl';
import { TicketTable } from './TicketTable';
import { Notice, Spinner } from './ui';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const ROLE_LABELS: Record<Role, string> = {
  Employee: 'Employee',
  IT_Agent: 'IT Agent',
  HR_Agent: 'HR Agent',
  Maintenance_Agent: 'Maintenance Agent',
  Admin: 'Admin',
};

// ---------------------------------------------------------------------------
// Tickets tab
// ---------------------------------------------------------------------------

function TicketsTab() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTickets(await apiListTickets());
      setNotice(null);
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not load tickets.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

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

// ---------------------------------------------------------------------------
// Users tab
// ---------------------------------------------------------------------------

const BLANK_FORM = { name: '', email: '', password: '', role: 'Employee' as Role };

function UsersTab() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(BLANK_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [patchingId, setPatchingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setUsers(await apiListUsers());
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not load users.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const newUser = await apiCreateUser(form);
      setUsers((prev) => [...prev, newUser]);
      setForm(BLANK_FORM);
      setNotice({ kind: 'success', text: `Account created for ${newUser.name} (${ROLE_LABELS[newUser.role]}).` });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not create user.' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleRoleChange = async (user: User, role: Role) => {
    setPatchingId(user.id);
    try {
      const updated = await apiPatchUserRole(user.id, role);
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      setNotice({ kind: 'success', text: `${updated.name}'s role updated to ${ROLE_LABELS[updated.role]}.` });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not update role.' });
    } finally {
      setPatchingId(null);
    }
  };

  return (
    <div className="stack">
      <Notice kind={notice?.kind ?? 'info'}>{notice?.text}</Notice>

      {/* Create user form */}
      <section className="card">
        <h2>Create account</h2>
        <form className="stack" onSubmit={(e) => void handleCreate(e)}>
          <div className="form-row">
            <label>Name</label>
            <input
              className="input"
              required
              minLength={2}
              placeholder="Full name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="form-row">
            <label>Email</label>
            <input
              className="input"
              type="email"
              required
              placeholder="user@company.com"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
          </div>
          <div className="form-row">
            <label>Password</label>
            <input
              className="input"
              type="password"
              required
              minLength={8}
              placeholder="Min. 8 characters"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
          </div>
          <div className="form-row">
            <label>Role</label>
            <select
              className="input"
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as Role }))}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
          </div>
          <button className="btn" type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create account'}
          </button>
        </form>
      </section>

      {/* User list */}
      <section className="card">
        <h2>All users ({users.length})</h2>
        {loading ? (
          <Spinner />
        ) : users.length === 0 ? (
          <p className="muted">No users yet.</p>
        ) : (
          <table className="ticket-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Change role</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="muted small">{u.id}</td>
                  <td>{u.name}</td>
                  <td className="small">{u.email}</td>
                  <td>
                    <span className="role-chip">{ROLE_LABELS[u.role]}</span>
                  </td>
                  <td>
                    <select
                      className="input"
                      value={u.role}
                      disabled={patchingId === u.id}
                      onChange={(e) => void handleRoleChange(u, e.target.value as Role)}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <button className="btn btn-ghost" onClick={() => void load()}>
        Refresh
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AdminView — tabbed shell
// ---------------------------------------------------------------------------

type Tab = 'tickets' | 'users';

/**
 * Admin dashboard: tabbed view with Tickets (global view + lifecycle actions)
 * and Users (create accounts, change roles) — product-spec §3, api.md §Admin.
 */
export function AdminView() {
  const [tab, setTab] = useState<Tab>('tickets');

  return (
    <div className="stack">
      <nav className="tab-bar">
        <button
          className={`tab-btn${tab === 'tickets' ? ' tab-btn--active' : ''}`}
          onClick={() => setTab('tickets')}
        >
          🎫 Tickets
        </button>
        <button
          className={`tab-btn${tab === 'users' ? ' tab-btn--active' : ''}`}
          onClick={() => setTab('users')}
        >
          👥 Users
        </button>
      </nav>

      {tab === 'tickets' ? <TicketsTab /> : <UsersTab />}
    </div>
  );
}
