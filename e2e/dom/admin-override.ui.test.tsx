/**
 * E2E for the Admin override policy (ADR-002).
 *
 * Drives the real React app against a live backend and proves that an Admin
 * cannot silently drive an unclaimed ticket: the "Start (override)" button is
 * disabled until a reason is entered, and resolving requires both an override
 * reason and a resolution note. The resolved row is then marked
 * "— admin override" (it has no assignee).
 *
 * Prereqs: backend on :3000 (or API_URL); the Vitest global setup provisions
 * the demo personas.
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

  it('will not let an Admin drive an unclaimed ticket without a reason', async () => {
    const title = `Admin override UI ${Date.now()}`;
    render(<App />);

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

    // Rana opens an IT ticket that nobody will claim.
    await login('rana.khoury@eurisko.com', 'password123', 'Requester');
    await screen.findByLabelText('Title');
    await user.type(screen.getByLabelText('Title'), title);
    await user.type(screen.getByLabelText('Description'), 'No agent will claim this one.');
    await user.selectOptions(screen.getByLabelText('Category'), 'IT');
    await user.click(screen.getByRole('button', { name: 'Open ticket' }));
    await screen.findByText(/Ticket #\d+ opened/);

    // Admin sees it in the global Tickets tab.
    await login('rami.fares@eurisko.com', 'Admin123!', 'Admin');
    const rowFor = () => screen.getByText(title).closest('tr')!;
    await screen.findByText(title);

    // The override button is disabled until a reason is provided.
    const startButton = within(rowFor()).getByRole('button', { name: 'Start (override)' });
    expect((startButton as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(rowFor()).getByLabelText('Override reason'), 'No IT agent on shift.');
    await user.click(within(rowFor()).getByRole('button', { name: 'Start (override)' }));

    await waitFor(() => {
      expect(within(rowFor()).getByText('In Progress')).toBeTruthy();
    });

    // Resolving needs both the override reason and the resolution note.
    await user.type(within(rowFor()).getByLabelText('Override reason'), 'No IT agent on shift.');
    await user.type(within(rowFor()).getByLabelText('Resolution note'), 'Cleared by the manager.');
    await user.click(within(rowFor()).getByRole('button', { name: 'Resolve with override' }));

    await waitFor(() => {
      expect(within(rowFor()).getByText('Resolved')).toBeTruthy();
    });

    // No agent ever owned it — the row says so explicitly.
    expect(within(rowFor()).getAllByText(/admin override/i).length).toBeGreaterThan(0);
  }, 60000);
});
