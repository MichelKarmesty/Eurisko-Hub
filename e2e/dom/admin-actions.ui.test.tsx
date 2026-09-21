/**
 * E2E for the Admin ticket actions (ADR-003):
 *  - assign an unclaimed ticket to a matching agent (gives it an owner), and
 *  - soft-cancel a request (kept with status Cancelled - never deleted).
 *
 * Prereqs: backend on :3000 (or API_URL); the Vitest global setup provisions
 * the test fixtures through the Admin API. No public registration (ADR-004).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../../frontend/src/App';

configure({ asyncUtilTimeout: 15000 });

const API = process.env.API_URL ?? 'http://localhost:3000';

function proxyFetch() {
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('/api')) url = `${API}${url.slice('/api'.length)}`;
    return real(url, init);
  }) as typeof fetch;
}

describe('Admin assign & cancel (ADR-003) in the UI', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    proxyFetch();
    localStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('assigns an unclaimed ticket and soft-cancels a duplicate', async () => {
    const stamp = Date.now();
    const assignTitle = `Assign me ${stamp}`;
    const cancelTitle = `Cancel me ${stamp}`;
    render(<App />);

    // Sign in as the provisioned test fixtures (no public registration, ADR-004).
    const login = async (email: string, password: string, role: string) => {
      const logout = screen.queryByRole('button', { name: 'Switch account' });
      if (logout) await user.click(logout);
      await screen.findByRole('heading', { name: 'Eurisko Hub' });
      const card = screen.getByRole('heading', { name: 'Eurisko Hub' }).closest('.auth-card')!;
      const form = card.querySelector('form')! as HTMLElement;
      await user.type(within(form).getByLabelText('Email'), email);
      await user.type(within(form).getByLabelText('Password'), password);
      await user.click(within(form).getByRole('button', { name: 'Log in' }));
      await screen.findByText(role, { selector: '.role-chip' });
    };

    // Rana opens two IT tickets.
    await login('rana.khoury@eurisko.com', 'password123', 'Requester');
    await screen.findByLabelText('Title');
    for (const title of [assignTitle, cancelTitle]) {
      await user.clear(screen.getByLabelText('Title'));
      await user.type(screen.getByLabelText('Title'), title);
      await user.type(screen.getByLabelText('Description'), 'Fixture for the admin actions E2E.');
      await user.click(screen.getByRole('button', { name: 'Open ticket' }));
      await screen.findByText(/Ticket #\d+ opened/);
    }

    // Admin: assign the first, cancel the second.
    await login('admin@eurisko.com', 'Admin123!', 'Admin');
    const rowFor = (title: string) => screen.getByText(title).closest('tr')!;
    await screen.findByText(assignTitle);

    // --- assign ---
    const assignRow = rowFor(assignTitle);
    await user.click(within(assignRow).getByRole('button', { name: 'Assign' }));
    await waitFor(() => {
      expect(within(rowFor(assignTitle)).getByText('In Progress')).toBeTruthy();
    });
    // A named agent now owns it.
    expect(within(rowFor(assignTitle)).getByText(/Karim|Nadim/)).toBeTruthy();

    // --- cancel (soft) ---
    await screen.findByText(cancelTitle);
    await user.click(within(rowFor(cancelTitle)).getByRole('button', { name: /Cancel request/ }));
    await user.type(within(rowFor(cancelTitle)).getByLabelText('Cancellation reason'), 'Duplicate request.');
    await user.click(within(rowFor(cancelTitle)).getByRole('button', { name: 'Cancel ticket' }));

    await waitFor(() => {
      expect(within(rowFor(cancelTitle)).getByText('Cancelled')).toBeTruthy();
    });
  }, 60000);
});
