/**
 * E2E for a tester's very first run (ADR-004): the app seeds only the Admin, so
 * someone has to sign in as the Admin and create the accounts to test with.
 *
 * This test drives that whole journey through the UI, exactly as a reviewer
 * would:
 *   Admin signs in -> 👥 Users -> Create account (Employee)
 *   -> Switch account -> the CREATED account signs in -> it opens a ticket.
 *
 * Prereqs: backend on :3000 (or API_URL). The Vitest global setup provisions
 * the shared fixtures; the account used here is created by this test and gets a
 * unique email, so repeat runs stay independent.
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

describe('First run: Admin creates an account, then signs in as it (ADR-004)', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    proxyFetch();
    localStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('creates an Employee in the Users tab and uses it to open a ticket', async () => {
    const stamp = Date.now();
    const name = `E2E Employee ${stamp}`;
    const email = `e2e.employee.${stamp}@eurisko.com`;
    const password = 'password123';
    const title = `Created-account ticket ${stamp}`;
    render(<App />);

    // The same helper the other DOM tests use: switch account if needed, then
    // sign in and wait for the role chip.
    const login = async (mail: string, pass: string, role: string) => {
      const logout = screen.queryByRole('button', { name: 'Switch account' });
      if (logout) await user.click(logout);
      await screen.findByRole('heading', { name: 'Eurisko Hub' });
      const card = screen.getByRole('heading', { name: 'Eurisko Hub' }).closest('.auth-card')!;
      const form = card.querySelector('form')! as HTMLElement;
      await user.type(within(form).getByLabelText('Email'), mail);
      await user.type(within(form).getByLabelText('Password'), pass);
      await user.click(within(form).getByRole('button', { name: 'Log in' }));
      await screen.findByText(role, { selector: '.role-chip' });
    };

    // 1. The Admin signs in (the only seeded account) and opens the Users tab -
    //    the only place an account can be created.
    await login('admin@eurisko.com', 'Admin123!', 'Admin');
    await user.click(screen.getByRole('button', { name: /Users/ }));
    await screen.findByRole('heading', { name: 'Create account' });

    // 2. Create an Employee, exactly as a tester would.
    await user.type(screen.getByLabelText('Name'), name);
    await user.type(screen.getByLabelText('Email'), email);
    await user.type(screen.getByLabelText('Password'), password);
    await user.selectOptions(screen.getByLabelText('Role'), 'Employee');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    // The account is confirmed and listed.
    await screen.findByText(`Account created for ${name} (Employee).`);
    const listedRow = screen.getByText(email).closest('tr')!;
    expect(within(listedRow).getByText(name)).toBeTruthy();

    // 3. Switch account and sign in AS THE ACCOUNT THE ADMIN JUST CREATED.
    await login(email, password, 'Requester');
    await screen.findByLabelText('Title');

    // 4. The created account can really work: it opens a ticket.
    await user.type(screen.getByLabelText('Title'), title);
    await user.type(
      screen.getByLabelText('Description'),
      'Opened by the account the Admin created in the Users tab.',
    );
    await user.click(screen.getByRole('button', { name: 'Open ticket' }));
    await screen.findByText(/Ticket #\d+ opened/);

    // 5. And it sees that ticket in its own list as Open.
    const myTickets = screen.getByRole('heading', { name: 'My tickets' }).closest('section')!;
    const ticketRow = within(myTickets).getByText(title).closest('tr')!;
    await waitFor(() => {
      expect(within(ticketRow).getByText('Open')).toBeTruthy();
    });
  }, 60000);
});
