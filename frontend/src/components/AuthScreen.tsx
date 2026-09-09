import { useState, type FormEvent } from 'react';
import { apiLogin } from '../api';
import type { Session } from '../types';
import { Notice } from './ui';

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
      const session = await apiLogin(email.trim(), password);
      onAuthed(session);
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
        <p className="muted">Internal Operations Service Hub — log in to continue.</p>

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
              placeholder="your@email.com"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              placeholder="Password"
            />
          </label>
          <div className="full">
            <button className="btn btn-primary" disabled={busy}>
              {busy ? 'Please wait…' : 'Log in'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
