import { useState, type FormEvent } from 'react';
import { apiLogin, apiResetPassword } from '../api';
import type { Session } from '../types';
import { Notice } from './ui';

type Mode = 'login' | 'reset';

/** Read a `?resetToken=…` from the URL so an Admin-issued reset link lands on the form. */
function resetTokenFromUrl(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('resetToken') ?? '';
}

/** Drop `?resetToken=…` from the address bar once it has been captured. */
function clearResetTokenFromUrl() {
  if (typeof window === 'undefined' || !window.location.search) return;
  window.history.replaceState({}, '', window.location.pathname);
}

/**
 * Sign in, and the reset form an Admin-issued link opens.
 *
 * This is an internal tool, so there is **no public registration** (ADR-004):
 * the backend seeds exactly one Admin account, and that Admin creates every
 * other account (employees and agents) from the **Users** tab.
 *
 * Recovery is **Admin-initiated** (ADR-007, ADR-009): there is no self-service
 * "forgot password" on this screen. When someone forgets theirs, the Admin mints
 * a one-time link (**Users → Reset password**) and hands it over; that link opens
 * this screen's reset form via `?resetToken=…`, and a user who was given the raw
 * token instead can paste it through the **"I have a reset token"** button. The
 * Admin never sees or chooses the password.
 *
 * Any real email address is accepted here: a personal provider such as Gmail,
 * Hotmail/Outlook or Yahoo, or a company domain. The app never ties accounts to
 * a single domain.
 */
export function AuthScreen({ onAuthed }: { onAuthed: (session: Session) => void }) {
  const [mode, setMode] = useState<Mode>(() =>
    resetTokenFromUrl() ? 'reset' : 'login',
  );

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [resetToken, setResetToken] = useState(() => resetTokenFromUrl());
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const goTo = (next: Mode) => {
    setMode(next);
    setError(null);
    setNotice(null);
  };

  const submitLogin = async (e: FormEvent<HTMLFormElement>) => {
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

  const submitReset = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiResetPassword(resetToken.trim(), newPassword);
      clearResetTokenFromUrl();
      setResetToken('');
      setNewPassword('');
      setConfirmPassword('');
      setMode('login');
      setNotice(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset the password.');
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
        <Notice kind="success">{notice}</Notice>

        {mode === 'login' && (
          <form className="grid-form" onSubmit={submitLogin}>
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder="you@gmail.com"
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
            <div className="full auth-links">
              {/* ADR-007/ADR-009: recovery is Admin-initiated. An Admin issues a
                  one-time link (Users → Reset password) that opens the form
                  below; a raw token can be pasted by hand. */}
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => goTo('reset')}
              >
                I have a reset token
              </button>
            </div>
          </form>
        )}

        {mode === 'reset' && (
          <form className="grid-form" onSubmit={submitReset}>
            <label className="full">
              Reset token
              <input
                value={resetToken}
                onChange={(e) => setResetToken(e.target.value)}
                required
                autoComplete="one-time-code"
                placeholder="Paste the token from your reset link"
              />
            </label>
            <label>
              New password
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
            </label>
            <label>
              Confirm new password
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
            </label>
            <div className="full auth-actions">
              <button className="btn btn-primary" disabled={busy}>
                {busy ? 'Please wait…' : 'Set new password'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => goTo('login')}
              >
                Back to sign in
              </button>
            </div>
          </form>
        )}

        <p className="muted small auth-footnote">
          No public sign-up. Accounts are created by an Admin from the
          <strong> Users</strong> tab after signing in. Forgotten password? Ask an
          <strong> Admin</strong> for a one-time reset link.
        </p>
      </div>
    </div>
  );
}
