import { useState, type FormEvent } from 'react';
import { apiLogin, apiRegister } from '../api';
import type { Session } from '../types';
import { Notice } from './ui';

/**
 * Login / Register.
 *
 * product-spec.md §3 + docs/api.md: "Users can register and log in".
 * Self-registration always creates an Employee account (the backend enforces
 * this); agent/admin accounts are provisioned by an Admin (Users tab).
 *
 * For local/demo use the backend seeds these personas on a fresh database
 * (SEED_DEMO_DATA), so the "Quick sign-in" buttons below log a reviewer in as
 * any role in one click. Keep this list in sync with DEMO_PERSONAS in
 * backend/src/app.module.ts.
 */
const DEMO_ACCOUNTS = [
  { label: 'Employee', name: 'Rana Khoury', email: 'rana.khoury@eurisko.com', password: 'password123', hint: 'Requester — opens tickets and follows their status' },
  { label: 'IT Agent', name: 'Karim Haddad', email: 'karim.haddad@eurisko.com', password: 'password123', hint: 'Serves the IT queue' },
  { label: 'IT Agent', name: 'Nadim Saad', email: 'nadim.saad@eurisko.com', password: 'password123', hint: 'Second IT agent — useful for the “not assigned” denied case' },
  { label: 'HR Agent', name: 'Layla Nassar', email: 'layla.nassar@eurisko.com', password: 'password123', hint: 'Serves the HR queue' },
  { label: 'Maintenance Agent', name: 'Elias Aoun', email: 'elias.aoun@eurisko.com', password: 'password123', hint: 'Serves the Maintenance queue' },
  { label: 'Admin', name: 'Rami Fares', email: 'rami.fares@eurisko.com', password: 'Admin123!', hint: 'Sees every ticket and manages users' },
];

export function AuthScreen({ onAuthed }: { onAuthed: (session: Session) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [quickBusy, setQuickBusy] = useState<string | null>(null);
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

  /** One-click sign-in for the seeded demo personas. */
  const quickLogin = async (account: (typeof DEMO_ACCOUNTS)[number]) => {
    setQuickBusy(account.email);
    setError(null);
    try {
      onAuthed(await apiLogin(account.email, account.password));
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not sign in as ${account.email}.`);
    } finally {
      setQuickBusy(null);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <h1>Eurisko Hub</h1>
        <p className="muted">
          Internal Operations Service Hub — log in or register as an employee.
        </p>

        <div className="demo-hint demo-hint--top">
          <p className="muted small">
            <strong>Quick sign-in</strong> — pick any role (demo accounts, one click):
          </p>
          <div className="demo-grid">
            {DEMO_ACCOUNTS.map((a) => (
              <button
                key={a.email}
                type="button"
                className="demo-btn"
                onClick={() => void quickLogin(a)}
                disabled={quickBusy !== null}
                title={a.hint}
              >
                <span className="demo-role">{a.label}</span>
                <span className="muted small">
                  {a.name} · {a.email}
                </span>
                {quickBusy === a.email ? (
                  <span className="muted small">Signing in…</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        <Notice kind="error">{error}</Notice>

        <div className="tabs">
          <button className={mode === 'login' ? 'tab active' : 'tab'} onClick={() => setMode('login')}>
            Log in
          </button>
          <button className={mode === 'register' ? 'tab active' : 'tab'} onClick={() => setMode('register')}>
            Register (Employee)
          </button>
        </div>

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

        <p className="muted small demo-footnote">
          Signed in as <strong>Admin</strong>? Open the <strong>Users</strong> tab to see and
          create every account.
        </p>
      </div>
    </div>
  );
}
