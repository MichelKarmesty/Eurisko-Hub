/**
 * API client for the Eurisko Hub backend.
 *
 * Contract: the "React action" sends exactly what docs/api.md defines, e.g.
 *   PATCH /tickets/:id/status  body { status: 'Resolved', resolutionNote }
 * All requests go through the Vite dev proxy (`/api` -> http://localhost:3000),
 * or to VITE_API_BASE when set.
 */
import type {
  AdminStats,
  Category,
  Priority,
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

export function apiLogin(email: string, password: string): Promise<Session> {
  return request<Session>('POST', '/auth/login', { email, password });
}

export function apiRegister(name: string, email: string, password: string): Promise<Session> {
  return request<Session>('POST', '/auth/register', { name, email, password });
}

export function apiMe(): Promise<User> {
  return request<User>('GET', '/auth/me');
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

/** ADR-001: an agent claims an OPEN ticket from their department queue. */
export function apiClaimTicket(id: number): Promise<Ticket> {
  return request<Ticket>('PATCH', `/tickets/${id}/claim`);
}

/**
 * The slice action: an assigned agent (or Admin) resolves the ticket.
 * Payload matches docs/api.md PATCH /tickets/:id/status.
 */
export function apiUpdateStatus(
  id: number,
  body: { status: 'In Progress' | 'Resolved'; resolutionNote?: string },
): Promise<Ticket> {
  return request<Ticket>('PATCH', `/tickets/${id}/status`, body);
}

export function apiTicketHistory(id: number): Promise<unknown[]> {
  return request('GET', `/tickets/${id}/history`);
}

// --- Admin ----------------------------------------------------------------

export function apiStats(): Promise<AdminStats> {
  return request<AdminStats>('GET', '/admin/stats');
}
