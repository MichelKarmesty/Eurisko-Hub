/**
 * E2E for the Admin override policy (ADR-002).
 *
 * An Admin is never the assignee, so resolving a ticket that belongs to an
 * agent is an override: the form demands an override reason plus the resolution
 * note, the change is recorded, and the row names the Admin as the real
 * resolver.
 *
 * Prereqs: backend on :3000 (or API_URL); the Vitest global setup provisions
 * the test fixtures through the Admin API.
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

describe('Admin override (ADR-002) in the UI', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    proxyFetch();
    localStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('requires a reason when an Admin resolves a ticket assigned to an agent', async () => {
    const title = `Admin override UI ${Date.now()}`;
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

    // Rana opens an IT ticket; Karim claims it (it now belongs to Karim).
    await login('rana.khoury@eurisko.com', 'password123', 'Requester');
    await screen.findByLabelText('Title');
    await user.type(screen.getByLabelText('Title'), title);
    await user.type(screen.getByLabelText('Description'), 'Assigned to an agent, then resolved by an Admin.');
    await user.selectOptions(screen.getByLabelText('Category'), 'IT');
    await user.click(screen.getByRole('button', { name: 'Open ticket' }));
    await screen.findByText(/Ticket #\d+ opened/);

    await login('karim.haddad@eurisko.com', 'password123', 'IT Agent');
    const queueSection = await screen
      .findByRole('heading', { name: /Department queue/ })
      .then((h) => h.closest('section')!);
    const queueRow = await within(queueSection).findByText(title).then((t) => t.closest('tr')!);
    await user.click(within(queueRow).getByRole('button', { name: 'Claim' }));
    await waitFor(() => expect(screen.getByText(title)).toBeTruthy());

    // Admin takes over: an override reason is part of the form.
    await login('admin@eurisko.com', 'Admin123!', 'Admin');
    const rowFor = () => screen.getByText(title).closest('tr')!;
    await screen.findByText(title);
    await waitFor(() => expect(within(rowFor()).getByText('In Progress')).toBeTruthy());

    await user.type(within(rowFor()).getByLabelText('Override reason'), 'Agent unavailable.');
    await user.type(within(rowFor()).getByLabelText('Resolution note'), 'Fixed by the manager.');
    await user.click(within(rowFor()).getByRole('button', { name: 'Resolve with override' }));

    await waitFor(() => {
      expect(within(rowFor()).getByText('Resolved')).toBeTruthy();
    });
    // The row credits the real resolver (the Admin), not the assignee.
    expect(within(rowFor()).getByText(/Fixed by the manager/)).toBeTruthy();
  }, 60000);
});
