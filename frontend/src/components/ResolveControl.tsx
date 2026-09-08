import { useState, type FormEvent } from 'react';
import { apiUpdateStatus } from '../api';
import type { Ticket } from '../types';

/**
 * The narrow slice — "React action".
 *
 * Rendered by the assigned agent (and by Admin, who is equally authorized)
 * on an `In Progress` ticket. Submits:
 *
 *   PATCH /tickets/:id/status  { "status": "Resolved", "resolutionNote": "…" }
 *
 * and hands the authoritative, updated ticket back to the parent so the UI
 * can move it to the "Resolved" section immediately. The backend rejects an
 * empty note with 400 — that message is surfaced right here in the form.
 */
export function ResolveControl({
  ticket,
  onResolved,
}: {
  ticket: Ticket;
  onResolved: (updated: Ticket) => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await apiUpdateStatus(ticket.id, {
        status: 'Resolved',
        resolutionNote: note.trim(),
      });
      onResolved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="resolve-form" onSubmit={submit}>
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Resolution note (required to resolve)…"
        aria-label="Resolution note"
        disabled={busy}
      />
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? 'Saving…' : 'Mark Resolved'}
      </button>
      {error && <div className="form-error">{error}</div>}
    </form>
  );
}
