import { useState, type FormEvent } from 'react';
import { apiUpdateStatus } from '../api';
import type { Ticket } from '../types';

/**
 * The narrow slice - "React action".
 *
 * Rendered by the assigned agent on an `In Progress` ticket, and by an Admin
 * (who reaches it through the explicit override path - ADR-002). Submits:
 *
 *   PATCH /tickets/:id/status
 *   { "status": "Resolved", "resolutionNote": "…" }                     // agent
 *   { …, "overrideReason": "…" }                                        // admin
 *
 * and hands the authoritative, updated ticket back to the parent so the UI can
 * move it to the "Resolved" section immediately. The backend rejects an empty
 * note (and a missing override reason) with 400 - the message is surfaced right
 * here in the form.
 */
export function ResolveControl({
  ticket,
  onResolved,
  overrideReasonRequired = false,
}: {
  ticket: Ticket;
  onResolved: (updated: Ticket) => void;
  /** ADR-002: an Admin resolving an unassigned ticket must justify the override. */
  overrideReasonRequired?: boolean;
}) {
  const [note, setNote] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
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
        ...(overrideReasonRequired
          ? { overrideReason: overrideReason.trim() }
          : {}),
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
      {overrideReasonRequired && (
        <input
          type="text"
          value={overrideReason}
          onChange={(e) => setOverrideReason(e.target.value)}
          placeholder="Override reason (required — this ticket has no assigned agent)…"
          aria-label="Override reason"
          disabled={busy}
        />
      )}
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Resolution note (required to resolve)…"
        aria-label="Resolution note"
        disabled={busy}
      />
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? 'Saving…' : overrideReasonRequired ? 'Resolve with override' : 'Mark Resolved'}
      </button>
      {error && <div className="form-error">{error}</div>}
    </form>
  );
}
