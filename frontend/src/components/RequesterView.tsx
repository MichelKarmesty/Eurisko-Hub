import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiAiSuggest, apiCreateTicket, apiListTickets } from '../api';
import type { Category, Priority, Ticket } from '../types';
import { TicketTable } from './TicketTable';
import { Notice } from './ui';

/** Which fields currently hold an AI suggestion (v0.4). */
type AiFlag = 'title' | 'category' | 'priority';

const NO_AI: Record<AiFlag, boolean> = { title: false, category: false, priority: false };

/**
 * Requester (Employee) workspace: open a ticket, then follow its status.
 * Per RBAC the requester cannot change status — only the assigned agent or
 * an Admin can — so no action cell is rendered here. The status column is
 * the "React result": after an agent resolves, a refresh shows Resolved.
 *
 * v0.4 (docs/week4-production-ai.md): the employee can describe the problem in
 * their own words and press **AI Suggest**. The AI fills in Category, Priority
 * and Title as a *suggestion* — every field stays editable, the markers drop
 * as soon as the employee types, and "Open ticket" still calls the unchanged
 * POST /tickets with the ordinary CreateTicketDto. If the AI is unavailable the
 * form simply carries on by hand.
 */
export function RequesterView() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);

  // v0.4 AI intake state.
  const [intakeText, setIntakeText] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [aiSuggested, setAiSuggested] = useState<Record<AiFlag, boolean>>(NO_AI);

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

  /** Editing a field by hand clears its "AI suggested" marker. */
  const clearAi = (field: AiFlag) =>
    setAiSuggested((prev) => (prev[field] ? { ...prev, [field]: false } : prev));

  const suggest = async () => {
    setSuggesting(true);
    setNotice(null);
    try {
      const result = await apiAiSuggest(intakeText.trim());
      if (!result.suggestion) {
        // Advisory feature: never blocks the employee from opening a ticket.
        setAiSuggested(NO_AI);
        setNotice({ kind: 'info', text: 'AI suggestions unavailable — fill in the fields manually.' });
        return;
      }
      const suggestion = result.suggestion;
      setTitle(suggestion.title);
      setCategory(suggestion.category);
      setPriority(suggestion.priority);
      setAiSuggested({ title: true, category: true, priority: true });
      setNotice({
        kind: 'success',
        text: `AI suggested ${suggestion.category} · ${suggestion.priority} — review it before opening the ticket.`,
      });
    } catch {
      setAiSuggested(NO_AI);
      setNotice({ kind: 'info', text: 'AI suggestions unavailable — fill in the fields manually.' });
    } finally {
      setSuggesting(false);
    }
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitting(true);
    setNotice(null);
    try {
      const created = await apiCreateTicket({ title, description, category, priority });
      setTickets((prev) => [created, ...prev]);
      setTitle('');
      setDescription('');
      setIntakeText('');
      setAiSuggested(NO_AI);
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

        {/* v0.4 — free-form description + advisory AI suggestion */}
        <div className="ai-intake">
          <label className="full">
            Describe the problem in your own words (optional)
            <textarea
              value={intakeText}
              onChange={(e) => setIntakeText(e.target.value)}
              rows={2}
              placeholder="e.g. My laptop screen keeps flickering and I can't work"
            />
          </label>
          <div className="ai-intake-actions">
            <button
              type="button"
              className="btn"
              onClick={() => void suggest()}
              disabled={suggesting || intakeText.trim().length < 3}
            >
              {suggesting ? 'Asking the AI…' : 'AI Suggest'}
            </button>
            <span className="muted small">
              The AI only suggests Category, Priority and Title. You can change anything before opening
              the ticket.
            </span>
          </div>
        </div>

        <form className="grid-form" onSubmit={submit}>
          <div className="field">
            {aiSuggested.title && <span className="ai-tag">AI suggested</span>}
            <label>
              Title
              <input
                className={aiSuggested.title ? 'ai-field' : undefined}
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  clearAi('title');
                }}
                required
                minLength={3}
              />
            </label>
          </div>
          <div className="field">
            {aiSuggested.category && <span className="ai-tag">AI suggested</span>}
            <label>
              Category
              <select
                className={aiSuggested.category ? 'ai-field' : undefined}
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value as Category);
                  clearAi('category');
                }}
              >
                <option>IT</option>
                <option>HR</option>
                <option>Maintenance</option>
              </select>
            </label>
          </div>
          <div className="field">
            {aiSuggested.priority && <span className="ai-tag">AI suggested</span>}
            <label>
              Priority
              <select
                className={aiSuggested.priority ? 'ai-field' : undefined}
                value={priority}
                onChange={(e) => {
                  setPriority(e.target.value as Priority);
                  clearAi('priority');
                }}
              >
                <option>Low</option>
                <option>Medium</option>
                <option>High</option>
              </select>
            </label>
          </div>
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
