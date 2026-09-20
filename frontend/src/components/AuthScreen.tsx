import { useState, type FormEvent } from 'react';
import { apiForgotPassword, apiLogin, apiResetPassword } from '../api';
import type { Session } from '../types';
import { Notice } from './ui';

type Mode = 'login' | 'forgot' | 'reset';

/** Read a `?resetToken=…` from the URL so an emailed reset link lands on the form. */
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
 * Sign in, and the two password-recovery paths.
 *
 * This is an internal tool, so there is **no public registration** (ADR-004):
 * the backend seeds exactly one Admin account, and that Admin creates every
 * other account (employees and agents) from the **Users** tab. The screen is
 * therefore a plain email + password form — plus **"Forgot password?"**, which
 * emails a one-time link, and the reset form that link opens.
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
  const [forgotEmail, setForgotEmail] = useState('');
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

  const submitForgot = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiForgotPassword(forgotEmail.trim());
      if (res.resetToken) {
        // No mail server configured (development/demo): carry the one-time
        // token straight into the reset form instead of pretending it was
        // emailed. A real deployment delivers it by email and this branch
        // never runs.
        setResetToken(res.resetToken);
        setNotice(
          `${res.message} No mail provider is configured, so here is your one-time link — set a new password below.`,
        );
      } else {
        setNotice(res.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the reset.');
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
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setForgotEmail(email);
                  goTo('forgot');
                }}
              >
                Forgot password?
              </button>
            </div>
          </form>
        )}

        {mode === 'forgot' && (
          <form className="grid-form" onSubmit={submitForgot}>
            <label className="full">
              Email
              <input
                type="email"
                value={forgotEmail}
                onChange={(e) => setForgotEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder="you@gmail.com"
              />
            </label>
            <p className="muted small full">
              Enter the email on your account — Gmail, Hotmail/Outlook, Yahoo or
              your company address. We will send a one-time link to choose a new
              password.
            </p>
            <div className="full auth-actions">
              <button className="btn btn-primary" disabled={busy}>
                {busy ? 'Please wait…' : 'Send reset link'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => goTo('reset')}
              >
                I have a reset token
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
          <strong> Users</strong> tab after signing in.
        </p>
      </div>
    </div>
  );
}
