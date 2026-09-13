import { useEffect, useState, type FormEvent } from 'react';
import { apiDemoAccounts, apiLogin, apiRegister } from '../api';
import type { DemoAccount, Session } from '../types';
import { Notice } from './ui';

/**
 * Login / Register.
 *
 * product-spec.md §3 + docs/api.md: "Users can register and log in".
 * Self-registration always creates an Employee account (the backend enforces
 * this); agent/admin accounts are provisioned by an Admin (Users tab).
 *
 * The "Quick sign-in" panel is driven by the dev-only `GET /demo/accounts`
 * endpoint, so the list of demo accounts lives in exactly one place
 * (`backend/src/common/demo-accounts.ts`) and reflects what was actually
 * seeded. In production that endpoint returns `[]` and the panel is hidden.
 */
export function AuthScreen({ onAuthed }: { onAuthed: (session: Session) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [quickBusy, setQuickBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [demoAccounts, setDemoAccounts] = useState<DemoAccount[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiDemoAccounts()
      .then((accounts) => {
        if (!cancelled) setDemoAccounts(accounts.filter((a) => a.password));
      })
      .catch(() => {
        // Demo discovery is optional; fall back to the manual form.
        if (!cancelled) setDemoAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
  const quickLogin = async (account: DemoAccount) => {
    if (!account.password) return;
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

        {demoAccounts.length > 0 && (
          <div className="demo-hint demo-hint--top">
            <p className="muted small">
              <strong>Quick sign-in</strong> — pick any role (demo accounts, one click):
            </p>
            <div className="demo-grid">
              {demoAccounts.map((a) => (
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
        )}

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

        {demoAccounts.length > 0 && (
          <p className="muted small demo-footnote">
            Signed in as <strong>Admin</strong>? Open the <strong>Users</strong> tab to see and
            create every account.
          </p>
        )}
      </div>
    </div>
  );
}
