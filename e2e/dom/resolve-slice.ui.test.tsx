/**
 * DOM-level UI test for the "assigned agent resolves a ticket" slice.
 *
 * Renders the REAL React app (frontend/src) in jsdom with Testing Library and
 * drives it exactly like a user, while fetch is proxied to the LIVE NestJS
 * backend on :3000. This is the browser-free equivalent of the Playwright E2E
 * (no browser install needed): every React action goes through real HTTP, so
 * the assertions prove the full DoD loop
 *
 *   React action -> PATCH /tickets/:id/status -> SQLite -> React result.
 *
 * Prereqs: backend on :3000 with a persistent DB and the demo accounts
 * (run: node ../scripts/verify-slice.mjs full once), then:
 *   npx vitest run
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import App from '../../frontend/src/App';

configure({ asyncUtilTimeout: 15000 });

const API = process.env.API_URL ?? 'http://localhost:3000';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ART = path.join(ROOT, 'artifacts', 'dom');

const NOTE = 'Replaced the docking cable and reseated the dock (UI test run).';

/** Route the app's relative /api calls to the live backend. */
function proxyFetch() {
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('/api')) url = `${API}${url.slice('/api'.length)}`;
    return real(url, init);
  }) as typeof fetch;
}

describe('Slice: assigned agent resolves a ticket (UI -> API -> UI)', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    proxyFetch();
    localStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('drives the full resolve flow through the real UI and backend', async () => {
    const title = `UI DOM test ${Date.now()} - docking station flickers`;

    render(<App />);

    // ---------- login helper used below ----------
    const login = async (email: string, password: string, expectRole: string) => {
      const logout = screen.queryByRole('button', { name: 'Switch account' });
      if (logout) await user.click(logout);
      // Wait for the auth screen (h1 only exists there, not in the topbar).
      await screen.findByRole('heading', { name: 'Eurisko Hub' });
      // Login-only screen (no demo-chip quick fill anymore): type credentials.
      const authForm = screen.getByRole('heading', { name: 'Eurisko Hub' }).closest('.auth-card')!.querySelector('form')!;
      const form = authForm as HTMLElement;
      await user.type(within(form).getByLabelText('Email'), email);
      await user.type(within(form).getByLabelText('Password'), password);
      await user.click(within(form).getByRole('button', { name: 'Log in' }));
      await screen.findByText(expectRole, { selector: '.role-chip' });
    };

    // 1. Alice opens a ticket --------------------------------------------
    await login('alice@corp.com', 'password123', 'Requester');
    await screen.findByLabelText('Title'); // form mounts after tickets load
    await user.type(screen.getByLabelText('Title'), title);
    await user.type(screen.getByLabelText('Description'), 'Docking station output flickers on the external monitor.');
    await user.selectOptions(screen.getByLabelText('Priority'), 'High');
    await user.click(screen.getByRole('button', { name: 'Open ticket' }));

    const opened = await screen.findByText(/Ticket #\d+ opened/);
    const idMatch = opened.textContent?.match(/Ticket #(\d+) opened/);
    expect(idMatch).not.toBeNull();
    const id = Number(idMatch![1]);

    // Requester sees it Open (React result on create)
    const myTable = screen.getByRole('heading', { name: 'My tickets' }).closest('section')!;
    const aliceRow = await within(myTable).findByText(title).then((t) => t.closest('tr')!);
    expect(aliceRow.textContent).toContain('Open');
    expect(aliceRow.textContent).toContain('IT');

    // 2. Bob claims it from the IT queue ----------------------------------
    await login('bob@corp.com', 'password123', 'IT Agent');
    const queueSection = await screen.findByRole('heading', { name: /Department queue/ }).then((h) => h.closest('section')!);
    const queueRow = await within(queueSection).findByText(title).then((t) => t.closest('tr')!);
    await user.click(within(queueRow).getByRole('button', { name: 'Claim' }));

    // wait for the claim outcome (success or error notice)
    await waitFor(() => {
      expect(document.body.textContent ?? '').toMatch(/Claimed ticket #\d+|could not claim|already claimed|Only agents/i);
    });
    const bodyAfterClaim = document.body.textContent ?? '';
    console.log('\n[diagnostic] claim outcome text:', (bodyAfterClaim.match(/(Claimed ticket #[^.\n]+|could not claim[^.\n]*|already claimed[^.\n]*|Only agents[^.\n]*)/i) ?? [])[0]);

    // Ticket moved to "My work · In Progress"
    const inProgressSection = await screen.findByRole('heading', { name: /My work · In Progress/ }).then((h) => h.closest('section')!);
    const workItem = await within(inProgressSection).findByText(new RegExp(`#${id} — `)).then((t) => t.closest('article')!);
    expect(workItem.textContent).toContain('In Progress');
    expect(within(workItem).getByRole('button', { name: 'Mark Resolved' })).toBeTruthy();

    // 3. Empty note -> backend 400 surfaced in the form --------------------
    await user.click(within(workItem).getByRole('button', { name: 'Mark Resolved' }));
    // Empty string is rejected by the DTO (@MinLength(1)); whitespace-only
    // would be rejected by the service rule — both surface as a 400 here.
    const formError = await within(workItem).findByText(/resolution/i, { selector: '.form-error' });
    console.log(`\n[diagnostic] empty-note 400 shown in UI: "${formError.textContent}"`);
    expect(formError.textContent).toMatch(/resolution/i);

    // 4. Bob resolves with a note ------------------------------------------
    await user.type(within(workItem).getByLabelText('Resolution note'), NOTE);
    await user.click(within(workItem).getByRole('button', { name: 'Mark Resolved' }));
    await screen.findByText(`Ticket #${id} resolved.`);

    // 5. UI reflects the change: ticket moved to the Resolved section -------
    const resolvedSection = screen.getByRole('heading', { name: /Resolved by me/ }).closest('section')!;
    const resolvedRow = await within(resolvedSection).findByText(title).then((t) => t.closest('tr')!);
    expect(resolvedRow.textContent).toContain('Resolved');
    expect(resolvedRow.textContent).toContain(NOTE);

    // "My work · In Progress" no longer lists it
    const inProgressHeading2 = screen.getByRole('heading', { name: /My work · In Progress/ });
    expect(within(inProgressHeading2.closest('section')!).queryByText(title)).toBeNull();

    mkdirSync(ART, { recursive: true });
    writeFileSync(path.join(ART, '2-bob-resolved-dom.html'), document.body.innerHTML);

    // 6. Requester sees Resolved + the note ---------------------------------
    await login('alice@corp.com', 'password123', 'Requester');
    const aliceTable = await screen.findByRole('heading', { name: 'My tickets' }).then((h) => h.closest('section')!);
    const finalRow = await within(aliceTable).findByText(title).then((t) => t.closest('tr')!);
    expect(finalRow.textContent).toContain('Resolved');
    expect(finalRow.textContent).toContain(NOTE);
    expect(finalRow.textContent).toContain('IT');
    writeFileSync(path.join(ART, '3-requester-resolved-dom.html'), document.body.innerHTML);

    console.log(`\nUI DOM flow passed for ticket #${id}: created Open -> claimed In Progress -> resolved with note -> requester sees Resolved + note.`);
  }, 60000);
});
