import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AuditTimeline } from './AuditTimeline';
import { reviewedAt } from '../../test-support/review';

afterEach(cleanup);
it('keeps the history control associated with its region and preserves actor, timestamp and decision payload', () => {
  const log = { id: 'synthetic-audit', event_type: 'DECISION_RECORDED', actor: 'user:synthetic-reviewer', created_at: reviewedAt,
    payload: { decision: 'ACCEPTED', previous_decision: 'PENDING', has_note: true } };
  render(<AuditTimeline auditLogs={[log]} />);
  const control = screen.getByRole('button', { name: /Activity & Event History/ });
  const region = document.getElementById(control.getAttribute('aria-controls')!)!;
  expect(region.hidden).toBe(true); fireEvent.click(control); expect(region.hidden).toBe(false);
  expect(control.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('user:synthetic-reviewer')).toBeTruthy();
  expect(screen.getByText(new Date(reviewedAt).toLocaleString())).toBeTruthy();
  expect(screen.getByText('ACCEPTED')).toBeTruthy(); expect(screen.getByText('PENDING')).toBeTruthy();
  expect(screen.getByText('Includes Note')).toBeTruthy(); fireEvent.click(control); expect(region.hidden).toBe(true);
  expect(log.created_at).toBe(reviewedAt); expect(log.payload.decision).toBe('ACCEPTED');
});
it('explains an empty supplied history without inventing events', () => {
  render(<AuditTimeline auditLogs={[]} />);
  fireEvent.click(screen.getByRole('button', { name: /Activity & Event History \(0\)/ }));
  expect(screen.getByText('No Case history is available.')).toBeTruthy();
  expect(screen.queryByText('Reviewer decision recorded')).toBeNull();
});
