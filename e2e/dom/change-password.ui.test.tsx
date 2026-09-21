/**
 * E2E: changing your own password from the top bar is available to **every**
 * signed-in role, not only the Admin.
 *
 * This pins the reported confusion directly ("change password only works for
 * the Admin"): the button lives in the top bar, `POST /auth/change-password`
 * is bearer-only (no `@Roles`), and the new password must really take effect -
 * which is proven here by signing in again with it.
 *
 * Prereqs: backend on :3000 (or API_URL) - the Vitest global setup provisions
 * the shared fixtures. The accounts used here are created by this test with
 * unique emails, so repeat runs stay independent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configure, render, screen, within } from '@testing-library/react';
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

describe('Change password from the top bar - every role, not only the Admin', () => {
  const user = userEvent.setup();
  const stamp = Date.now();

  beforeEach(() => {
    proxyFetch();
    localStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  async function login(mail: string, pass: string, role: string) {
    const logout = screen.queryByRole('button', { name: 'Switch account' });
    if (logout) await user.click(logout);
    await screen.findByRole('heading', { name: 'Eurisko Hub' });
    const card = screen.getByRole('heading', { name: 'Eurisko Hub' }).closest('.auth-card')!;
    const form = card.querySelector('form')! as HTMLElement;
    await user.type(within(form).getByLabelText('Email'), mail);
    await user.type(within(form).getByLabelText('Password'), pass);
    await user.click(within(form).getByRole('button', { name: 'Log in' }));
    await screen.findByText(role, { selector: '.role-chip' });
  }

  /** Admin-only screen, exactly as the other DOM tests use it. */
  async function createAccount(role: 'Employee' | 'IT_Agent', name: string) {
    const email = `pw.${name.replace(/\s+/g, '').toLowerCase()}.${stamp}@eurisko.com`;
    const password = 'password123';
    await user.click(screen.getByRole('button', { name: /Users/ }));
    await screen.findByRole('heading', { name: 'Create account' });
    await user.type(screen.getByLabelText('Name'), name);
    await user.type(screen.getByLabelText('Email'), email);
    await user.type(screen.getByLabelText('Password'), password);
    await user.selectOptions(screen.getByLabelText('Role'), role);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByText(new RegExp(`Account created for ${name}`));
    return { email, password };
  }

  /** Open the dialog from the top bar, fill it in, submit, return the dialog. */
  async function changePassword(current: string, next: string, confirm = next) {
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change password' });
    await user.type(within(dialog).getByLabelText('Current password'), current);
    await user.type(within(dialog).getByLabelText('New password'), next);
    await user.type(within(dialog).getByLabelText('Confirm new password'), confirm);
    await user.click(within(dialog).getByRole('button', { name: 'Change password' }));
    return dialog;
  }

  it('lets an Employee and an IT agent change their own password', async () => {
    render(<App />);
    await login('admin@eurisko.com', 'Admin123!', 'Admin');

    const employee = await createAccount('Employee', `E2E Pw Employee ${stamp}`);
    const agent = await createAccount('IT_Agent', `E2E Pw Agent ${stamp}`);

    // --- the Employee: the button is there, and the change goes through ------
    await login(employee.email, employee.password, 'Requester');
    const first = await changePassword(employee.password, 'employee-new-456');
    await within(first).findByText(/password has been changed/i);
    await user.click(within(first).getByRole('button', { name: 'Close' }));

    // The new password is really in force - signing in with it proves the change.
    await login(employee.email, 'employee-new-456', 'Requester');

    // --- the IT agent: the role that "could not change it" -------------------
    await login(agent.email, agent.password, 'IT Agent');
    const second = await changePassword(agent.password, 'agent-new-789');
    await within(second).findByText(/password has been changed/i);
    await user.click(within(second).getByRole('button', { name: 'Close' }));
    await login(agent.email, 'agent-new-789', 'IT Agent');

    // --- and a wrong current password is refused, visibly -------------------
    const third = await changePassword('definitely-not-my-password', 'whatever-123');
    await within(third).findByText(/current password is incorrect/i);
  }, 90000);
});
