import { useState, type FormEvent } from 'react';
import { apiLogin } from '../api';
import type { Session } from '../types';
import { Notice } from './ui';

/**
 * Sign in.
 *
 * This is an internal tool, so there is **no public registration** (ADR-004):
 * the backend seeds exactly one Admin account, and that Admin creates every
 * other account (employees and agents) from the **Users** tab. The screen is
 * therefore a plain email + password form — nothing else.
 */
export function AuthScreen({ onAuthed }: { onAuthed: (session: Session) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onAuthed(await apiLogin(email.trim(), password));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <h1>Eurisko Hub</h1>
        <p className="muted">
          Internal Operations Service Hub — sign in to continue.
        </p>

        <Notice kind="error">{error}</Notice>

        <form className="grid-form" onSubmit={submit}>
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="you@eurisko.com"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={1}
              autoComplete="current-password"
            />
          </label>
          <div className="full">
            <button className="btn btn-primary" disabled={busy}>
              {busy ? 'Please wait…' : 'Log in'}
            </button>
          </div>
        </form>

        <p className="muted small auth-footnote">
          No public sign-up. Accounts are created by an Admin from the
          <strong> Users</strong> tab after signing in.
        </p>
      </div>
    </div>
  );
}
