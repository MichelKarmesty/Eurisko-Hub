/**
 * AUTOMATED TEST FOR A BUSINESS RULE (Week 3 requirement).
 *
 * The rule under test is the ticket lifecycle documented in
 * docs/data-model.md §2 and enforced by TicketsService.changeStatus:
 *
 *   A ticket moves one step at a time: Open -> In Progress -> Resolved.
 *   It can never skip a step, never move backwards, and never reopen.
 *
 * These tests are deliberately pure and fast (no Nest, no database): the rule
 * lives in `src/common/domain.ts` so the whole app shares one definition.
 */
import {
  ROLE_DEPARTMENT,
  STATUS_ORDER,
  isAdminRole,
  isAgentRole,
  statusCanTransition,
} from '../src/common/domain';

describe('Business rule — the ticket lifecycle moves exactly one step forward', () => {
  it('publishes the documented order', () => {
    expect(STATUS_ORDER).toEqual(['Open', 'In Progress', 'Resolved']);
  });

  it('allows each single forward step', () => {
    expect(statusCanTransition('Open', 'In Progress')).toBe(true);
    expect(statusCanTransition('In Progress', 'Resolved')).toBe(true);
  });

  it('rejects skipping a step (Open -> Resolved)', () => {
    expect(statusCanTransition('Open', 'Resolved')).toBe(false);
  });

  it('rejects every backward transition', () => {
    expect(statusCanTransition('In Progress', 'Open')).toBe(false);
    expect(statusCanTransition('Resolved', 'In Progress')).toBe(false);
    expect(statusCanTransition('Resolved', 'Open')).toBe(false);
  });

  it('rejects a no-op transition', () => {
    expect(statusCanTransition('Open', 'Open')).toBe(false);
    expect(statusCanTransition('Resolved', 'Resolved')).toBe(false);
  });
});

describe('Business rule — an agent serves exactly one department', () => {
  it('maps every agent role to its category', () => {
    expect(ROLE_DEPARTMENT.IT_Agent).toBe('IT');
    expect(ROLE_DEPARTMENT.HR_Agent).toBe('HR');
    expect(ROLE_DEPARTMENT.Maintenance_Agent).toBe('Maintenance');
  });

  it('distinguishes agent, employee and admin roles', () => {
    expect(isAgentRole('IT_Agent')).toBe(true);
    expect(isAgentRole('Employee')).toBe(false);
    expect(isAgentRole('Admin')).toBe(false);
    expect(isAdminRole('Admin')).toBe(true);
    expect(isAdminRole('HR_Agent')).toBe(false);
  });
});
