/**
 * Regression test for the demo "Quick sign-in" panel on the login card.
 *
 * A reviewer should be able to open ANY role with one click. This test drives
 * the real React app against the live backend and proves the Employee and Admin
 * buttons log in directly (no password typing), then that "Switch account"
 * returns to the picker.
 *
 * Prereqs: backend on :3000 (or API_URL) with demo personas — the Vitest global
 * setup provisions them automatically.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../../frontend/src/App';

const API = process.env.API_URL ?? 'http://localhost:3000';

function proxyFetch() {
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('/api')) url = `${API}${url.slice('/api'.length)}`;
    return real(url, init);
  }) as typeof fetch;
}

describe('Demo quick sign-in', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    proxyFetch();
    localStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens the Employee and Admin accounts in one click each', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'Eurisko Hub' });

    // One click on "Employee" -> signed in as the Requester.
    await user.click(screen.getByRole('button', { name: /^Employee/ }));
    await screen.findByText('Requester', { selector: '.role-chip' });

    // Back to the picker, then one click on "Admin".
    await user.click(screen.getByRole('button', { name: 'Switch account' }));
    await screen.findByRole('heading', { name: 'Eurisko Hub' });
    await user.click(screen.getByRole('button', { name: /^Admin/ }));
    await screen.findByText('Admin', { selector: '.role-chip' });
  }, 30000);
});
