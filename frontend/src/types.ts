/**
 * Eurisko Hub — domain types.
 * Mirrors backend/src/common/domain.ts and docs/data-model.md so the client
 * and the API speak the same vocabulary (the server remains the source of
 * truth for rules — the client only mirrors valid values for the UI).
 */

export const CATEGORIES = ['IT', 'HR', 'Maintenance'] as const;
export type Category = (typeof CATEGORIES)[number];

export const PRIORITIES = ['Low', 'Medium', 'High'] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * docs/data-model.md §2: Open -> In Progress -> Resolved, plus `Cancelled` —
 * a terminal state an Admin can set (ADR-003). Kept out of the linear flow.
 */
export const STATUSES = ['Open', 'In Progress', 'Resolved', 'Cancelled'] as const;
export type TicketStatus = (typeof STATUSES)[number];

export const ROLES = [
  'Employee',
  'IT_Agent',
  'HR_Agent',
  'Maintenance_Agent',
  'Admin',
] as const;
export type Role = (typeof ROLES)[number];

export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
}

export interface Session {
  accessToken: string;
  user: User;
}

export interface Ticket {
  id: number;
  title: string;
  description: string;
  category: Category;
  priority: Priority;
  status: TicketStatus;
  requesterId: number;
  assignedToId: number | null;
  resolvedById: number | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
  requester?: User;
  assignedTo?: User | null;
  resolvedBy?: User | null;
}

export interface TicketEvent {
  id: number;
  ticketId: number;
  actorId: number;
  action:
    | 'CREATED'
    | 'CLAIMED'
    | 'ASSIGNED'
    | 'STATUS_CHANGED'
    | 'RESOLVED'
    | 'ADMIN_OVERRIDE'
    | 'CANCELLED';
  fromStatus: TicketStatus | null;
  toStatus: TicketStatus | null;
  note: string | null;
  createdAt: string;
  actor?: User;
}

export interface AdminStats {
  total: number;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
  openUnclaimed: number;
  highPriorityOpen: number;
}

/**
 * v0.4 — AI-assisted intake (docs/week4-production-ai.md).
 * Mirrors backend/src/ai/ai-intake.service.ts. The AI only *suggests*: the
 * employee can change every field, and POST /tickets stays authoritative.
 */
export interface AiIntakeSuggestion {
  category: Category;
  priority: Priority;
  title: string;
  confidence: number;
  /**
   * v0.6 — `false` when the text did not read as a support request at all
   * (random characters, a greeting, a test, something unrelated to work). The
   * UI then shows the companion `notice` and pre-fills nothing.
   *
   * Optional on purpose: an answer that does not carry the field at all means
   * "relevant", so an older backend can never make the form accuse the
   * employee's message of being nonsense.
   */
  relevant?: boolean;
  /** Short explanation of `relevant: false`, supplied by the backend. */
  reason?: string;
}

export interface AiIntakeResult {
  suggestion: AiIntakeSuggestion | null;
  error?: string;
  /** `'ai'` when the configured model answered, `'offline'` for the keyword fallback. */
  source?: 'ai' | 'offline';
  /**
   * Explanation shown to the employee when the offline fallback was used, or
   * when the suggestion is not relevant.
   */
  notice?: string;
}
