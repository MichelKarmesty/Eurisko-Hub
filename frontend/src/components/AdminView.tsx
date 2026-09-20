import { useCallback, useEffect, useState } from 'react';
import {
  apiListTickets,
  apiUpdateStatus,
  apiListUsers,
  apiCreateUser,
  apiPatchUserRole,
  apiDeleteUser,
  apiAdminResetPassword,
  apiMe,
  apiAssignTicket,
  apiCancelTicket,
  apiDeleteTicket,
  apiSetUserActive,
  apiAdminSetPassword,
} from '../api';
import type { AdminStats, Category, Ticket, User } from '../types';
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

/** Mirrors backend ROLE_DEPARTMENT: an agent only serves one category. */
const AGENT_DEPARTMENT: Partial<Record<Role, Category>> = {
  IT_Agent: 'IT',
  HR_Agent: 'HR',
  Maintenance_Agent: 'Maintenance',
};

/**
 * ADR-003: the normal Admin action for an unclaimed ticket — hand it to an
 * agent of the matching department so it has a named owner (Open -> In
 * Progress). Submits PATCH /tickets/:id/assign { assigneeId }.
 */
function AdminAssignControl({
  agents,
  busy,
  onAssign,
}: {
  agents: User[];
  busy: boolean;
  onAssign: (assigneeId: number) => void;
}) {
  const [assigneeId, setAssigneeId] = useState<number | ''>(agents[0]?.id ?? '');

  if (agents.length === 0) return null;

  return (
    <form
      className="resolve-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (assigneeId) onAssign(Number(assigneeId));
      }}
    >
      <select
        className="input"
        value={assigneeId}
        onChange={(e) => setAssigneeId(e.target.value ? Number(e.target.value) : '')}
        aria-label="Assign to agent"
        disabled={busy}
      >
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} ({ROLE_LABELS[a.role]})
          </option>
        ))}
      </select>
      <button type="submit" className="btn" disabled={busy || !assigneeId}>
        {busy ? '…' : 'Assign'}
      </button>
    </form>
  );
}

/**
 * ADR-003: retire a request that should not be worked. Soft cancel — the
 * ticket and its history are kept, never deleted. Submits
 * PATCH /tickets/:id/cancel { reason }.
 */
function AdminCancelControl({
  busy,
  onCancel,
}: {
  busy: boolean;
  onCancel: (reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)} disabled={busy}>
        Cancel request…
      </button>
    );
  }

  return (
    <form
      className="resolve-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) {
          onCancel(reason);
          setOpen(false);
          setReason('');
        }
      }}
    >
      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Cancellation reason (required)…"
        aria-label="Cancellation reason"
        disabled={busy}
      />
      <button type="submit" className="btn" disabled={busy || !reason.trim()}>
        {busy ? '…' : 'Cancel ticket'}
      </button>
    </form>
  );
}

/**
 * ADR-002: an Admin moving an Open ticket to In Progress without assigning it
 * is overriding the manual queue, so a reason is mandatory. Submits
 * PATCH /tickets/:id/status { status: 'In Progress', overrideReason }.
 */
function AdminStartControl({
  busy,
  onStart,
}: {
  busy: boolean;
  onStart: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');

  return (
    <form
      className="resolve-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) onStart(reason);
      }}
    >
      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Override reason (required)…"
        aria-label="Override reason"
        disabled={busy}
      />
      <button type="submit" className="btn" disabled={busy || !reason.trim()}>
        {busy ? '…' : 'Start (override)'}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Tickets tab
// ---------------------------------------------------------------------------

function TicketsTab() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [agents, setAgents] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [filter, setFilter] = useState<'all' | 'unclaimed' | 'inProgress' | 'resolved' | 'cancelled'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ticketList, userList] = await Promise.all([apiListTickets(), apiListUsers()]);
      setTickets(ticketList);
      // Only active agents can be assigned; a deactivated row must never be
      // offered as an assignee (defensive: the list is active-only already).
      setAgents(userList.filter((u) => AGENT_DEPARTMENT[u.role] && u.isActive !== false));
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

  /** Shared busy/notice wrapper for the Admin actions. */
  const run = async (t: Ticket, action: () => Promise<Ticket>, success: string) => {
    setBusyId(t.id);
    try {
      replace(await action());
      setNotice({ kind: 'success', text: success });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Action failed.' });
    } finally {
      setBusyId(null);
    }
  };

  const start = (t: Ticket, overrideReason: string) =>
    run(
      t,
      () => apiUpdateStatus(t.id, { status: 'In Progress', overrideReason: overrideReason.trim() }),
      `Ticket #${t.id} is now In Progress (admin override recorded).`,
    );

  const assign = (t: Ticket, assigneeId: number) =>
    run(t, () => apiAssignTicket(t.id, assigneeId), `Ticket #${t.id} assigned.`);

  const cancel = (t: Ticket, reason: string) =>
    run(t, () => apiCancelTicket(t.id, reason.trim()), `Ticket #${t.id} cancelled.`);

  /**
   * ADR-010: permanently delete a **Resolved** ticket. Unlike every other Admin
   * action the record does not survive — the ticket and its history rows are
   * removed from the database — so this is the one action that asks for an
   * explicit confirmation spelling that out.
   */
  const removeTicket = async (t: Ticket) => {
    if (
      !window.confirm(
        `Delete ticket #${t.id} — “${t.title}”?\n\n` +
          'This permanently removes the ticket and its entire history from the database. ' +
          'It cannot be undone and the requester will no longer see it.\n\n' +
          '(A request that should not be worked is cancelled instead — that keeps the record.)',
      )
    ) {
      return;
    }
    setBusyId(t.id);
    try {
      await apiDeleteTicket(t.id);
      setTickets((prev) => prev.filter((x) => x.id !== t.id));
      setNotice({ kind: 'success', text: `Ticket #${t.id} deleted.` });
    } catch (err) {
      setNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Could not delete the ticket.',
      });
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
        <div className="admin-filter-row">
          {(
            [
              ['all', `All (${stats.total})`],
              ['unclaimed', `Unclaimed (${stats.openUnclaimed})`],
              ['inProgress', `In Progress (${stats.byStatus['In Progress'] ?? 0})`],
              ['resolved', `Resolved (${stats.byStatus['Resolved'] ?? 0})`],
              ['cancelled', `Cancelled (${stats.byStatus['Cancelled'] ?? 0})`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={`chip${filter === key ? ' chip--active' : ''}`}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {filter === 'unclaimed' && (
          <p className="muted small">
            Unclaimed Open tickets — assign one to a matching agent to get it moving,
            or start it yourself as a recorded override.
          </p>
        )}

        <TicketTable
          tickets={tickets.filter((t) => {
            if (filter === 'unclaimed') return t.status === 'Open' && t.assignedToId == null;
            if (filter === 'inProgress') return t.status === 'In Progress';
            if (filter === 'resolved') return t.status === 'Resolved';
            if (filter === 'cancelled') return t.status === 'Cancelled';
            return true;
          })}
          empty={
            filter === 'all'
              ? 'No tickets in the system.'
              : filter === 'unclaimed'
                ? 'Nothing unclaimed — every Open ticket is being handled.'
                : filter === 'inProgress'
                  ? 'No tickets in progress right now.'
                  : filter === 'resolved'
                    ? 'No resolved tickets yet.'
                    : 'No cancelled tickets.'
          }
          actions={(t) => {
            if (t.status === 'Open') {
              const eligible = agents.filter((a) => AGENT_DEPARTMENT[a.role] === t.category);
              return (
                <div className="admin-actions">
                  {eligible.length > 0 ? (
                    // Preferred: give the ticket an owner (ADR-003).
                    <AdminAssignControl
                      agents={eligible}
                      busy={busyId === t.id}
                      onAssign={(assigneeId) => void assign(t, assigneeId)}
                    />
                  ) : (
                    // No matching agent exists — the only way forward is an
                    // explicit, recorded override (ADR-002).
                    <AdminStartControl
                      busy={busyId === t.id}
                      onStart={(reason) => void start(t, reason)}
                    />
                  )}
                  <AdminCancelControl busy={busyId === t.id} onCancel={(reason) => void cancel(t, reason)} />
                </div>
              );
            }
            if (t.status === 'In Progress') {
              return (
                <div className="admin-actions">
                  {/* ADR-002: an Admin is never the assignee, so this is an
                      override and the reason is mandatory. */}
                  <ResolveControl ticket={t} onResolved={replace} overrideReasonRequired />
                  <AdminCancelControl busy={busyId === t.id} onCancel={(reason) => void cancel(t, reason)} />
                </div>
              );
            }
            if (t.status === 'Resolved') {
              return (
                <div className="admin-actions">
                  {/* ADR-010: a Resolved ticket is the only one an Admin may
                      delete outright; its history goes with it. */}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busyId === t.id}
                    onClick={() => void removeTicket(t)}
                  >
                    {busyId === t.id ? 'Deleting…' : 'Delete ticket'}
                  </button>
                </div>
              );
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
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [resettingId, setResettingId] = useState<number | null>(null);
  /**
   * ADR-007: the last one-time reset link an Admin minted, kept on screen so it
   * can be copied and handed over. Never persisted anywhere.
   */
  const [resetResult, setResetResult] = useState<
    { id: number; name: string; email: string; resetUrl: string; expiresInMinutes: number } | null
  >(null);
  /** ADR-011: the password the Admin types to set it directly for that account. */
  const [directPassword, setDirectPassword] = useState('');
  const [settingPassword, setSettingPassword] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, me] = await Promise.all([apiListUsers(true), apiMe()]);
      setUsers(list);
      setCurrentUserId(me.id);
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

  /**
   * Account lifecycle (ADR-004): reactivate a deactivated account, or revoke an
   * active one. Reactivating is the supported way to bring an address back —
   * the deactivated row kept the email, so creating a second account with it is
   * refused (409) and this is what unblocks that message.
   */
  const setActive = async (u: User, active: boolean) => {
    setPatchingId(u.id);
    try {
      const updated = await apiSetUserActive(u.id, active);
      setUsers((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      setNotice({
        kind: 'success',
        text: active
          ? `${updated.email} reactivated — that address can sign in again.`
          : `${updated.email} deactivated — the login is revoked, the history is kept.`,
      });
    } catch (err) {
      setNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Could not update the account.',
      });
    } finally {
      setPatchingId(null);
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

  /**
   * Admin deletes any account — Employee, IT/HR/Maintenance agent, or another
   * Admin. The backend refuses deleting your own account and the last active
   * Admin; an account with history is deactivated rather than destroyed so the
   * tickets/history stay intact. Either way it leaves this list immediately.
   *
   * The confirmation spells out both outcomes, because the **hard** delete is
   * irreversible and frees the email address: the UI cannot know in advance
   * whether tickets reference the account (only the DELETE response reports the
   * mode), so the Admin is told exactly what each case means before confirming.
   */
  const handleDelete = async (user: User) => {
    if (
      !window.confirm(
        `Delete ${user.name} (${user.email})?\n\n` +
          'If the account has no tickets or history it is PERMANENTLY deleted, and ' +
          `${user.email} can then be used to create a new account again.\n\n` +
          'If it appears in any ticket or history entry, the records are kept for audit ' +
          'instead: its login is revoked, it is hidden from the list, and the email stays ' +
          'in use (a new account with the same email is refused).\n\n' +
          'Either way the account can no longer sign in.',
      )
    ) {
      return;
    }
    setDeletingId(user.id);
    try {
      const result = await apiDeleteUser(user.id);
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
      setNotice({
        kind: 'success',
        text:
          result.mode === 'deleted'
            ? `Account ${user.email} deleted.`
            : `Account ${user.email} deleted — it had tickets/history, so the records were kept and the login was revoked.`,
      });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not delete the account.' });
    } finally {
      setDeletingId(null);
    }
  };

  /**
   * ADR-007: mint a one-time reset link for a user who forgot their password.
   * Needs no mail server — the Admin copies the link and hands it over, and the
   * employee chooses their own new password (the Admin never sees it).
   */
  const handleResetPassword = async (user: User) => {
    setResettingId(user.id);
    try {
      const result = await apiAdminResetPassword(user.id);
      setResetResult({
        id: user.id,
        name: user.name,
        email: result.email,
        resetUrl: result.resetUrl,
        expiresInMinutes: result.expiresInMinutes,
      });
      setDirectPassword('');
      setNotice({
        kind: 'success',
        text: `One-time reset link created for ${user.name} — hand it over; it expires in ${result.expiresInMinutes} minutes and works once.`,
      });
    } catch (err) {
      setResetResult(null);
      setNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Could not create a reset link.',
      });
    } finally {
      setResettingId(null);
    }
  };

  const copyResetLink = async () => {
    if (!resetResult) return;
    try {
      await navigator.clipboard.writeText(resetResult.resetUrl);
      setNotice({ kind: 'success', text: 'Reset link copied to the clipboard.' });
    } catch {
      setNotice({
        kind: 'error',
        text: 'Could not copy automatically — select the link and copy it by hand.',
      });
    }
  };

  /**
   * ADR-011: set that account's password right here, instead of handing over a
   * link. The backend hashes it and clears the link that was just minted, so the
   * Admin can simply tell the person the new password.
   */
  const setPasswordDirectly = async () => {
    if (!resetResult || directPassword.length < 8) return;
    setSettingPassword(true);
    try {
      await apiAdminSetPassword(resetResult.id, directPassword);
      setDirectPassword('');
      setNotice({
        kind: 'success',
        text: `Password updated for ${resetResult.email} — give it to them; the link above no longer works. They can change it from the top bar.`,
      });
    } catch (err) {
      setNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Could not set the password.',
      });
    } finally {
      setSettingPassword(false);
    }
  };

  return (
    <div className="stack">
      <Notice kind={notice?.kind ?? 'info'}>{notice?.text}</Notice>

      {/* First-run guidance: a fresh hub contains only the seeded Admin, and
          there is no public registration (ADR-004), so the next step is to
          create the accounts the slice needs. */}
      {!loading && users.length > 0 && users.every((u) => u.role === 'Admin') && (
        <Notice kind="info">
          Fresh hub — only Admin accounts exist. Create an <strong>Employee</strong> (Requester) and
          the <strong>IT</strong> / <strong>HR</strong> / <strong>Maintenance</strong> agents below,
          then use <strong>Switch account</strong> (top right) to sign in as them and test the
          ticket flow.
        </Notice>
      )}

      {/* ADR-007: a freshly minted one-time reset link, shown so the Admin can
          copy it and hand it over. It is never stored anywhere. */}
      {resetResult && (
        <section className="card">
          <h2>Reset link for {resetResult.name}</h2>
          <p className="muted small">
            Give this one-time link to <strong>{resetResult.email}</strong>. It expires in{' '}
            {resetResult.expiresInMinutes} minutes and works once. They choose their own new
            password — you never see it.
          </p>
          <div className="form-row">
            <input
              className="input"
              readOnly
              value={resetResult.resetUrl}
              aria-label="One-time password reset link"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" className="btn" onClick={() => void copyResetLink()}>
              Copy link
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setResetResult(null)}
            >
              Dismiss
            </button>
          </div>

          {/* ADR-011: the direct alternative — set the password here and hand it
              over, instead of waiting for the person to open a link. */}
          <div className="form-row" style={{ marginTop: '0.75rem' }}>
            <label htmlFor="admin-set-password" className="full">
              Or set {resetResult.email}'s password now
            </label>
            <input
              id="admin-set-password"
              className="input"
              type="password"
              minLength={8}
              autoComplete="new-password"
              placeholder="New password (min. 8 characters)"
              value={directPassword}
              onChange={(e) => setDirectPassword(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={settingPassword || directPassword.length < 8}
              onClick={() => void setPasswordDirectly()}
            >
              {settingPassword ? 'Setting…' : 'Set password'}
            </button>
          </div>
          <p className="muted small">
            Stored hashed like any password. Setting it here <strong>invalidates the link
            above</strong>; the Admin who sets a password knows it, so tell them to change it
            from the top bar after signing in.
          </p>
        </section>
      )}

      {/* Create user form */}
      <section className="card">
        <h2>Create account</h2>
        {/* autoComplete="off" + a "new-password" field keep the browser's password
            manager from filling the Admin's own saved credentials into a form that
            is meant to be typed fresh for somebody else. The form is also cleared
            after every successful create (see handleCreate). */}
        <form className="stack" autoComplete="off" onSubmit={(e) => void handleCreate(e)}>
          <div className="form-row">
            <label htmlFor="new-user-name">Name</label>
            <input
              id="new-user-name"
              className="input"
              required
              minLength={2}
              placeholder="Full name"
              autoComplete="off"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="form-row">
            <label htmlFor="new-user-email">Email</label>
            <input
              id="new-user-email"
              className="input"
              type="email"
              required
              placeholder="user@company.com"
              autoComplete="off"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
          </div>
          <div className="form-row">
            <label htmlFor="new-user-password">Password</label>
            <input
              id="new-user-password"
              className="input"
              type="password"
              required
              minLength={8}
              placeholder="Min. 8 characters"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
          </div>
          <div className="form-row">
            <label htmlFor="new-user-role">Role</label>
            <select
              id="new-user-role"
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
                <th>Status</th>
                <th>Change role</th>
                <th>Actions</th>
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
                    {u.isActive === false ? (
                      <span className="role-chip" title="Deactivated: ticket history references this account, so the row (and its email) were kept.">
                        Deactivated
                      </span>
                    ) : (
                      <span className="muted small">Active</span>
                    )}
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
                  <td>
                    <div className="admin-actions">
                      {/* ADR-007: mint a one-time link for anyone who forgot
                          their password — no mail server required. */}
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={resettingId === u.id || u.isActive === false}
                        onClick={() => void handleResetPassword(u)}
                      >
                        {resettingId === u.id ? 'Creating…' : 'Reset password'}
                      </button>
                      {/* ADR-004: a deactivated row keeps its email, so this is
                          the way that address comes back into use. */}
                      {u.isActive === false ? (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={patchingId === u.id}
                          onClick={() => void setActive(u, true)}
                        >
                          {patchingId === u.id ? 'Reactivating…' : 'Reactivate'}
                        </button>
                      ) : (
                        u.id !== currentUserId && (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={patchingId === u.id}
                            onClick={() => void setActive(u, false)}
                          >
                            {patchingId === u.id ? 'Deactivating…' : 'Deactivate'}
                          </button>
                        )
                      )}
                      {/* Deleting your own account is refused by the backend
                          (400) — hide the control for your own row instead. */}
                      {u.id === currentUserId ? (
                        <span className="muted small">you</span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-danger"
                          disabled={deletingId === u.id}
                          onClick={() => void handleDelete(u)}
                        >
                          {deletingId === u.id ? 'Deleting…' : 'Delete'}
                        </button>
                      )}
                    </div>
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
 * and Users (create accounts, change roles, delete accounts) — product-spec §3,
 * api.md §Admin.
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
