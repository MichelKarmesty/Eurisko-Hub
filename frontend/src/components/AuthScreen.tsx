import { useState, type FormEvent } from 'react';
import { apiLogin, apiRegister } from '../api';
import type { Session } from '../types';
import { Notice } from './ui';

/**
 * Login / Register.
 *
 * product-spec.md §3 + docs/api.md: "Users can register and log in".
 * Self-registration always creates an Employee account (the backend enforces
 * this); agent/admin accounts are provisioned by an Admin (Users tab) or via
 * scripts/verify-slice.mjs.
 */

/** Demo personas created by scripts/verify-slice.mjs against a fresh DB. */
const DEMO_ACCOUNTS = [
  { label: 'Admin', email: 'admin@eurisko.local', password: 'Admin123!', hint: 'seeded on first boot' },
  { label: 'Requester (Alice)', email: 'alice@corp.com', password: 'password123', hint: 'Employee' },
  { label: 'IT Agent (Bob)', email: 'bob@corp.com', password: 'password123', hint: 'IT_Agent' },
  { label: 'IT Agent (Dave)', email: 'dave@corp.com', password: 'password123', hint: 'IT_Agent' },
  { label: 'HR Agent (Carol)', email: 'carol@corp.com', password: 'password123', hint: 'HR_Agent' },
  { label: 'Maintenance Agent (Eve)', email: 'eve@corp.com', password: 'password123', hint: 'Maintenance_Agent' },
];

export function AuthScreen({ onAuthed }: { onAuthed: (session: Session) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session =
        mode === 'login'
          ? await apiLogin(email.trim(), password)
          : await apiRegister(name.trim(), email.trim(), password);
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
        <p className="muted">
          Internal Operations Service Hub — log in or register as an employee.
        </p>
        <div className="tabs">
          <button className={mode === 'login' ? 'tab active' : 'tab'} onClick={() => setMode('login')}>
            Log in
          </button>
          <button className={mode === 'register' ? 'tab active' : 'tab'} onClick={() => setMode('register')}>
            Register (Employee)
          </button>
        </div>

        <Notice kind="error">{error}</Notice>

        <form className="grid-form" onSubmit={submit}>
          {mode === 'register' && (
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} autoComplete="name" />
            </label>
          )}
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" placeholder="your@email.com" />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === 'register' ? 8 : 1}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </label>
          <div className="full">
            <button className="btn btn-primary" disabled={busy}>
              {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
            </button>
          </div>
        </form>

        <div className="demo-hint">
          <p className="muted small">
            <strong>Demo accounts</strong> — click one to fill the form, then press “Log in”:
          </p>
          <div className="chip-row">
            {DEMO_ACCOUNTS.map((a) => (
              <button
                key={a.email}
                className="chip"
                onClick={() => {
                  setMode('login');
                  setEmail(a.email);
                  setPassword(a.password);
                }}
                title={a.hint}
              >
                {a.label} · {a.email}
              </button>
            ))}
          </div>
          <p className="muted small">
            Signed in as <strong>Admin</strong>? Open the <strong>Users</strong> tab to see and
            create every account.
          </p>
        </div>
      </div>
    </div>
  );
}
