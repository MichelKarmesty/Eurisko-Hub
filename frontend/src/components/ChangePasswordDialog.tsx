import { useState, type FormEvent } from 'react';
import { apiChangePassword } from '../api';
import { Notice } from './ui';

/**
 * Change your own password while signed in (`POST /auth/change-password`).
 *
 * The current password is required, so holding a session token is not by itself
 * enough to take the account over. The backend hashes the new value and clears
 * any outstanding reset token at the same time.
 */
export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await apiChangePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setDone(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Change password"
    >
      <div className="card modal">
        <h2>Change password</h2>
        <p className="muted small">
          Choose a new password of at least 8 characters.
        </p>

        <Notice kind="error">{error}</Notice>
        <Notice kind="success">{done}</Notice>

        <form className="grid-form" onSubmit={submit}>
          <label className="full">
            Current password
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              autoComplete="current-password"
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
              {busy ? 'Please wait…' : 'Change password'}
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
