// ============================================================================
// Eurisko Hub — Shared domain vocabulary.
// Mirrors docs/data-model.md (categories, priority, status) and the README
// role list (Employee, IT_Agent, HR_Agent, Maintenance_Agent, Admin).
// ============================================================================

export const CATEGORIES = ['IT', 'HR', 'Maintenance'] as const;
export type Category = (typeof CATEGORIES)[number];

export const PRIORITIES = ['Low', 'Medium', 'High'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** docs/data-model.md §2 / docs/api.md — lifecycle: Open -> In Progress -> Resolved. */
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

/** Roles that act as support agents with a department. */
export const AGENT_ROLES: readonly Role[] = [
  'IT_Agent',
  'HR_Agent',
  'Maintenance_Agent',
];

/**
 * Maps an agent role to its department category (architecture.md: the Ticket
 * module "limits agents to their department").
 */
export const ROLE_DEPARTMENT: Record<Exclude<Role, 'Employee' | 'Admin'>, Category> = {
  IT_Agent: 'IT',
  HR_Agent: 'HR',
  Maintenance_Agent: 'Maintenance',
};

export const isAgentRole = (role: Role): boolean =>
  (AGENT_ROLES as readonly string[]).includes(role);

export const isAdminRole = (role: Role): boolean => role === 'Admin';

/**
 * Linear lifecycle: Open -> In Progress -> Resolved.
 * A ticket may only move one step forward at a time; no skipping or reversal.
 */
export const STATUS_ORDER: readonly TicketStatus[] = [
  'Open',
  'In Progress',
  'Resolved',
];

export const statusCanTransition = (
  from: TicketStatus,
  to: TicketStatus,
): boolean => {
  const i = STATUS_ORDER.indexOf(from);
  return i >= 0 && i < STATUS_ORDER.length - 1 && STATUS_ORDER[i + 1] === to;
};
