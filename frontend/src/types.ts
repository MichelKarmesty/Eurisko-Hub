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

/** docs/data-model.md §2: Open -> In Progress -> Resolved. */
export const STATUSES = ['Open', 'In Progress', 'Resolved'] as const;
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
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
  requester?: User;
  assignedTo?: User | null;
}

export interface TicketEvent {
  id: number;
  ticketId: number;
  actorId: number;
  action: 'CREATED' | 'CLAIMED' | 'STATUS_CHANGED' | 'RESOLVED';
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

/** One step forward on the documented lifecycle. */
export const nextStatus = (s: TicketStatus): TicketStatus | null => {
  const i = STATUSES.indexOf(s);
  return i >= 0 && i < STATUSES.length - 1 ? STATUSES[i + 1] : null;
};
