import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { JobStatus } from './JobStatus';
import { syntheticJob } from '../../test-support/jobs';

afterEach(cleanup);
const props = () => ({ error: false, checking: false, onCheck: vi.fn() });

it('labels queued work as accepted, without implying completion or inventing a timestamp or Case link', () => {
  const actions = props(); render(<JobStatus {...actions} job={syntheticJob({ id: 'accepted-job' })} />);
  expect(screen.getByRole('status').textContent).toBe('Queued');
  expect(screen.getByText('Accepted and waiting to start.')).toBeTruthy();
  expect(screen.queryByText(/completed\./)).toBeNull();
  expect(screen.queryByText('Finished')).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.queryByRole('progressbar')).toBeNull();
  const check = screen.getByRole('button', { name: 'Check again' });
  expect(document.getElementById(check.getAttribute('aria-describedby')!)?.textContent).toBe('accepted-job');
  fireEvent.click(check); expect(actions.onCheck).toHaveBeenCalledTimes(1);
});

it('renders running counts with an unknown total without inventing a denominator or percentage', () => {
  render(<JobStatus {...props()} job={syntheticJob({ status: 'RUNNING', total_rows: null, processed_rows: 7, rejected_rows: 2 })} />);
  expect(screen.getByRole('status').textContent).toBe('Running');
  expect(screen.getByText('Records processed: 7. Rejected: 2.')).toBeTruthy();
  expect(screen.queryByText(/ of null|undefined|%/)).toBeNull();
  expect(screen.queryByText(/completed\./)).toBeNull();
});

it('shows a confirmed completion, reported imported/rejected counts and only actual available timestamps', () => {
  const finished = '2026-10-12T08:45:00Z';
  render(<JobStatus {...props()} job={syntheticJob({ status: 'SUCCEEDED', total_rows: 3, processed_rows: 3, successful_rows: 2, rejected_rows: 1, completed_at: finished })} />);
  expect(screen.getByRole('status').textContent).toBe('Completed');
  expect(screen.getByText('AI evidence extraction completed. 2 records imported.')).toBeTruthy();
  expect(screen.getByText('Records processed: 3 of 3. Rejected: 1.')).toBeTruthy();
  expect(screen.getByText(new Date(finished).toLocaleString())).toBeTruthy();
  expect(screen.queryByText('Started')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

it('shows safe CSV failure guidance and never exposes raw internal failure data or a resubmission action', () => {
  render(<JobStatus {...props()} job={syntheticJob({ job_type: 'CSV_INGEST', status: 'FAILED', failure_code: 'INTERNAL_SECRET', failure_message: 'PRIVATE DATABASE DETAIL' })} />);
  expect(screen.getByRole('status').textContent).toBe('Failed');
  expect(screen.getByRole('alert').textContent).toContain('Check the CSV format and values');
  expect(screen.queryByText(/PRIVATE DATABASE|INTERNAL_SECRET/)).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

it('keeps a failed read separate from a failed Job and associates recovery with the same Job reference', () => {
  const actions = props(); render(<JobStatus {...actions} error job={syntheticJob({ id: 'read-only-job', status: 'RUNNING', processed_rows: 2, total_rows: 9 })} />);
  expect(screen.getByRole('status').textContent).toBe('Last known status: Running');
  expect(screen.getByRole('alert').textContent).toContain('The Job was accepted, but its latest processing status could not be confirmed.');
  expect(screen.getByText('Last reported records: 2 of 9.')).toBeTruthy();
  expect(screen.queryByText(/extraction failed/)).toBeNull();
  const check = screen.getByRole('button', { name: 'Check again' });
  const descriptions = check.getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)?.textContent).join(' ');
  expect(descriptions).toContain('read-only-job'); expect(descriptions).toContain('does not submit another');
  fireEvent.click(check); expect(actions.onCheck).toHaveBeenCalledTimes(1);
});

it.each(['SUCCEEDED', 'FAILED'] as const)('preserves a previously confirmed %s result when a newer read is unavailable', status => {
  render(<JobStatus {...props()} error job={syntheticJob({ status })} />);
  expect(screen.getByRole('status').textContent).toBe(`Last known status: ${status === 'SUCCEEDED' ? 'Completed' : 'Failed'}`);
  expect(screen.getByText(/Last confirmed result:/)).toBeTruthy();
  expect(screen.getByText('Could not check the latest status. The last confirmed result is shown.')).toBeTruthy();
  expect(screen.queryByText(/The outcome is unknown/)).toBeNull();
});

it('keeps compact timestamp details readable and disables a pending status check without changing the Job result', () => {
  const actions = props(); const started = '2026-10-12T09:01:00Z';
  render(<JobStatus {...actions} compact checking job={syntheticJob({ status: 'RUNNING', started_at: started })} />);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Checking status…' }).disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toBe('Running');
  fireEvent.click(screen.getByText('Processing timestamps'));
  expect(screen.getByText('Processing timestamps').closest('details')?.open).toBe(true);
  expect(screen.getByText(new Date(started).toLocaleString())).toBeTruthy();
  expect(actions.onCheck).not.toHaveBeenCalled();
});
