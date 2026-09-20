/**
 * API client for the Eurisko Hub backend.
 *
 * Contract: the "React action" sends exactly what docs/api.md defines, e.g.
 *   PATCH /tickets/:id/status  body { status: 'Resolved', resolutionNote }
 * All requests go through the Vite dev proxy (`/api` -> http://localhost:3000),
 * or to VITE_API_BASE when set.
 */
import type {
  AdminResetResult,
  AiIntakeResult,
  Category,
  Priority,
  Role,
  Session,
  Ticket,
  TicketStatus,
  User,
} from './types';

const BASE = import.meta.env.VITE_API_BASE ?? '/api';

const TOKEN_KEY = 'eurisko.token';

let authToken: string | null = localStorage.getItem(TOKEN_KEY);

export function setToken(token: string | null) {
  authToken = token;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getToken(): string | null {
  return authToken;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    // NestJS error bodies: { message: string | string[], error, statusCode }.
    const msg =
      data && typeof data === 'object' && 'message' in data
        ? Array.isArray((data as { message: unknown }).message)
          ? (data as { message: string[] }).message.join('; ')
          : String((data as { message: unknown }).message)
        : `Request failed with status ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

// --- Authentication -------------------------------------------------------

/**
 * Sign in. There is no registration (ADR-004); any real email address works
 * (Gmail, Hotmail/Outlook, Yahoo, a company domain…).
 */
export function apiLogin(email: string, password: string): Promise<Session> {
  return request<Session>('POST', '/auth/login', { email, password });
}

export function apiMe(): Promise<User> {
  return request<User>('GET', '/auth/me');
}

export interface ForgotPasswordResult {
  /** Generic, non-enumerating confirmation (registered or not). */
  message: string;
  /**
   * Present only outside production (the backend's PASSWORD_RESET_RETURN_TOKEN
   * switch): the one-time token, so the flow is usable with no mail server.
   * A real deployment delivers it by email instead.
   */
  resetToken?: string;
  resetUrl?: string;
  /** How the message actually left the backend: smtp, smtp-alt, webhook, resend or console. */
  delivery?: 'smtp' | 'smtp-alt' | 'webhook' | 'resend' | 'console';
}

/**
 * "I forgot my password" — step 1 (ADR-008): emails a one-time reset link to
 * the account's address. The answer is always the same generic message so the
 * endpoint cannot enumerate accounts; with no mail provider configured (or as a
 * dev convenience) the token is returned so the flow stays demonstrable.
 */
export function apiForgotPassword(email: string): Promise<ForgotPasswordResult> {
  return request<ForgotPasswordResult>('POST', '/auth/forgot-password', { email });
}

/**
 * Complete a reset with the one-time token from an emailed (ADR-008) or
 * **Admin-issued** (ADR-007: `apiAdminResetPassword`, or
 * `scripts/reset-password.mjs`) link and the new password (step 2).
 */
export function apiResetPassword(
  token: string,
  password: string,
): Promise<{ message: string }> {
  return request('POST', '/auth/reset-password', { token, password });
}

/** Change your own password while signed in (requires the current one). */
export function apiChangePassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ message: string }> {
  return request('POST', '/auth/change-password', { currentPassword, newPassword });
}

// --- Tickets --------------------------------------------------------------

export interface TicketListQuery {
  status?: TicketStatus;
  category?: Category;
  priority?: Priority;
  mine?: boolean;
}

export function apiListTickets(query: TicketListQuery = {}): Promise<Ticket[]> {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.category) params.set('category', query.category);
  if (query.priority) params.set('priority', query.priority);
  if (query.mine) params.set('mine', 'true');
  const qs = params.toString();
  return request<Ticket[]>('GET', `/tickets${qs ? `?${qs}` : ''}`);
}

export function apiCreateTicket(input: {
  title: string;
  description: string;
  category: Category;
  priority: Priority;
}): Promise<Ticket> {
  return request<Ticket>('POST', '/tickets', input);
}

/**
 * v0.4 (docs/week4-production-ai.md): ask the AI to suggest Category, Priority
 * and Title from a free-form description. Advisory and side-effect free — it
 * never creates a ticket. A provider that is disabled, down or too slow comes
 * back as `{ suggestion: null, error }`, so the caller can carry on by hand.
 */
export function apiAiSuggest(text: string): Promise<AiIntakeResult> {
  return request<AiIntakeResult>('POST', '/tickets/ai-suggest', { text });
}

/** ADR-001: an agent claims an OPEN ticket from their department queue. */
export function apiClaimTicket(id: number): Promise<Ticket> {
  return request<Ticket>('PATCH', `/tickets/${id}/claim`);
}

/**
 * The slice action: an assigned agent (or Admin) resolves the ticket.
 * Payload matches docs/api.md PATCH /tickets/:id/status.
 *
 * ADR-002: when an Admin acts on a ticket not assigned to them, the request
 * must include `overrideReason`.
 */
export function apiUpdateStatus(
  id: number,
  body: {
    status: 'In Progress' | 'Resolved';
    resolutionNote?: string;
    overrideReason?: string;
  },
): Promise<Ticket> {
  return request<Ticket>('PATCH', `/tickets/${id}/status`, body);
}

export function apiTicketHistory(id: number): Promise<unknown[]> {
  return request('GET', `/tickets/${id}/history`);
}

/**
 * ADR-003: an Admin gives an unclaimed ticket an owner by assigning it to an
 * agent of the matching department (Open -> In Progress, `ASSIGNED` event).
 */
export function apiAssignTicket(id: number, assigneeId: number, note?: string): Promise<Ticket> {
  return request<Ticket>('PATCH', `/tickets/${id}/assign`, { assigneeId, note });
}

/**
 * ADR-003: an Admin retires a request. Soft cancel — the ticket and its
 * history are kept (status becomes `Cancelled`); it is never deleted.
 */
export function apiCancelTicket(id: number, reason: string): Promise<Ticket> {
  return request<Ticket>('PATCH', `/tickets/${id}/cancel`, { reason });
}

// --- User management (Admin only) -----------------------------------------

export function apiListUsers(): Promise<User[]> {
  return request<User[]>('GET', '/users');
}

export function apiCreateUser(input: {
  name: string;
  email: string;
  password: string;
  role: Role;
}): Promise<User> {
  return request<User>('POST', '/users', input);
}

export function apiPatchUserRole(id: number, role: Role): Promise<User> {
  return request<User>('PATCH', `/users/${id}/role`, { role });
}

/**
 * Admin deletes any account (Employee, IT/HR/Maintenance agent, another Admin).
 * The backend really deletes an account with no history, and deactivates one
 * that appears in tickets/history so the audit trail survives; either way the
 * account disappears from the list and can no longer sign in.
 */
export function apiDeleteUser(
  id: number,
): Promise<{ id: number; email: string; mode: 'deleted' | 'deactivated' }> {
  return request('DELETE', `/users/${id}`);
}

/**
 * ADR-007: Admin-initiated password recovery — mints a one-time reset link for
 * an account and returns it, so the Admin can hand it to the employee. Needs no
 * mail provider; the employee sets their own password and the Admin never sees
 * it. Single-use and time-limited (docs/security.md).
 */
export function apiAdminResetPassword(id: number): Promise<AdminResetResult> {
  return request<AdminResetResult>('POST', `/users/${id}/reset-password`);
}
