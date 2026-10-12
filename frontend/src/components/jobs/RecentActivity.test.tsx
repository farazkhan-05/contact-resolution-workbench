import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { RecentActivity } from './RecentActivity';
import { syntheticJob } from '../../test-support/jobs';

vi.mock('../../api/client', async original => {
  const actual = await original<typeof import('../../api/client')>();
  return { ...actual, api: Object.fromEntries(Object.keys(actual.api).map(key => [key, vi.fn()])) };
});
beforeEach(() => { vi.mocked(api.listJobs).mockResolvedValue([]); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const props = () => ({ workspaceId: 'test-workspace', revision: 0, expanded: true, onToggle: vi.fn(), onRefreshCases: vi.fn() });
const completed = (id: string) => syntheticJob({ id, status: 'SUCCEEDED', successful_rows: 1 });
const reads = () => within(screen.getByRole('group', { name: 'Activity reads' }));
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it('distinguishes initial loading from a successful empty history', async () => {
  const pending = deferred<Awaited<ReturnType<typeof api.listJobs>>>(); vi.mocked(api.listJobs).mockReturnValue(pending.promise);
  render(<RecentActivity {...props()} />);
  expect(screen.getByRole('status').textContent).toBe('Loading recent activity...');
  expect(screen.queryByText('No recent imports.')).toBeNull();
  await act(async () => pending.resolve([]));
  expect(screen.getByText('No recent imports.')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it.each(['records', 'empty'] as const)('retries an unavailable activity read using GETs only and recovers %s', async outcome => {
  vi.mocked(api.listJobs).mockRejectedValueOnce(Error('Synthetic activity read failure')).mockResolvedValueOnce(outcome === 'records' ? [completed('recovered-job')] : []);
  render(<RecentActivity {...props()} />);
  await screen.findByText('Recent activity unavailable.');
  expect(screen.queryByText('No recent imports.')).toBeNull();
  fireEvent.click(reads().getByRole('button', { name: 'Check again' }));
  if (outcome === 'records') await screen.findByText('recovered-job');
  else await screen.findByText('No recent imports.');
  expect(screen.queryByRole('alert')).toBeNull(); expect(api.listJobs).toHaveBeenCalledTimes(2);
  for (const write of [api.ingestCsv, api.ingestUnstructured, api.submitDecision, api.startInvestigation, api.resumeInvestigation]) expect(write).not.toHaveBeenCalled();
});

it('labels retained activity when the next history read fails and never calls it empty', async () => {
  vi.mocked(api.listJobs).mockResolvedValueOnce([completed('last-loaded-job')]).mockRejectedValueOnce(Error('Synthetic subsequent read failure'));
  render(<RecentActivity {...props()} />); await screen.findByText('last-loaded-job');
  fireEvent.click(reads().getByRole('button', { name: 'Check again' }));
  await screen.findByText('Showing the last loaded activity.');
  expect(screen.getByText('last-loaded-job')).toBeTruthy(); expect(screen.queryByText('No recent imports.')).toBeNull();
});

it.each(['success', 'failure'] as const)('ignores an obsolete activity %s after a newer revision returns', async outcome => {
  const old = deferred<Awaited<ReturnType<typeof api.listJobs>>>();
  vi.mocked(api.listJobs).mockReturnValueOnce(old.promise).mockResolvedValueOnce([completed('current-job')]);
  const actions = props(); const view = render(<RecentActivity {...actions} />);
  view.rerender(<RecentActivity {...actions} revision={1} />); await screen.findByText('current-job');
  await act(async () => { if (outcome === 'success') old.resolve([completed('obsolete-job')]); else old.reject(Error('Obsolete failure')); });
  expect(screen.getByText('current-job')).toBeTruthy(); expect(screen.queryByText('obsolete-job')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull(); expect(screen.queryByText('Loading recent activity...')).toBeNull();
});

it('does not let an obsolete success clear the current activity error', async () => {
  const old = deferred<Awaited<ReturnType<typeof api.listJobs>>>();
  vi.mocked(api.listJobs).mockReturnValueOnce(old.promise).mockRejectedValueOnce(Error('Current activity failure'));
  const actions = props(); const view = render(<RecentActivity {...actions} />);
  view.rerender(<RecentActivity {...actions} revision={1} />); await screen.findByText('Recent activity unavailable.');
  await act(async () => old.resolve([]));
  expect(screen.getByRole('alert').textContent).toContain('Recent activity unavailable.');
  expect(screen.queryByText('No recent imports.')).toBeNull();
});

it('keeps collapsed read recovery available and preserves the existing toggle and Cases refresh actions', async () => {
  vi.mocked(api.listJobs).mockRejectedValueOnce(Error('Synthetic collapsed read failure')).mockResolvedValueOnce([]);
  const actions = props(); const view = render(<RecentActivity {...actions} expanded={false} />);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Check again' })); await screen.findByRole('button', { name: 'Recent activity' });
  fireEvent.click(screen.getByRole('button', { name: 'Recent activity' })); expect(actions.onToggle).toHaveBeenCalledTimes(1);
  view.rerender(<RecentActivity {...actions} />); await screen.findByText('No recent imports.');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh cases' })); expect(actions.onRefreshCases).toHaveBeenCalledTimes(1);
  expect(api.ingestUnstructured).not.toHaveBeenCalled(); expect(api.ingestCsv).not.toHaveBeenCalled();
});
