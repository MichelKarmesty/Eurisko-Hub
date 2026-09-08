import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiCreateTicket, apiListTickets } from '../api';
import type { Category, Priority, Ticket } from '../types';
import { TicketTable } from './TicketTable';
import { Notice } from './ui';

/**
 * Requester (Employee) workspace: open a ticket, then follow its status.
 * Per RBAC the requester cannot change status — only the assigned agent or
 * an Admin can — so no action cell is rendered here. The status column is
 * the "React result": after an agent resolves, a refresh shows Resolved.
 */
export function RequesterView() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<Category>('IT');
  const [priority, setPriority] = useState<Priority>('Medium');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      setTickets(await apiListTickets());
    } catch {
      setNotice({ kind: 'error', text: 'Could not load your tickets — check the connection.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitting(true);
    setNotice(null);
    try {
      const created = await apiCreateTicket({ title, description, category, priority });
      setTickets((prev) => [created, ...prev]);
      setTitle('');
      setDescription('');
      setNotice({ kind: 'success', text: `Ticket #${created.id} opened — status "${created.status}".` });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to open the ticket.' });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <p className="muted">Loading your tickets…</p>;

  return (
    <div className="stack">
      <Notice kind={notice?.kind ?? 'info'}>{notice?.text}</Notice>

      <section className="card">
        <h2>New request</h2>
        <form className="grid-form" onSubmit={submit}>
          <label>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} />
          </label>
          <label>
            Category
            <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
              <option>IT</option>
              <option>HR</option>
              <option>Maintenance</option>
            </select>
          </label>
          <label>
            Priority
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              <option>Low</option>
              <option>Medium</option>
              <option>High</option>
            </select>
          </label>
          <label className="full">
            Description
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} required minLength={3} rows={3} />
          </label>
          <div className="full">
            <button className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Opening…' : 'Open ticket'}
            </button>
          </div>
        </form>
      </section>

      <section className="card">
        <h2>My tickets</h2>
        <TicketTable tickets={tickets} empty="You have not opened any tickets yet." />
        <button className="btn btn-ghost" onClick={() => void load()}>
          Refresh
        </button>
      </section>
    </div>
  );
}
