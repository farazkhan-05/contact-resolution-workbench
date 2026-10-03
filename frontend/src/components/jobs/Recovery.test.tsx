import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../api/client';
import { syntheticJob } from '../../test-support/jobs';
import type { Job } from '../../types';
import { AiExtractionModal } from '../cases/AiExtractionModal';
import { RecentActivity } from './RecentActivity';
import { useJobStatus } from './useJobStatus';
import { JobStatus } from './JobStatus';

vi.mock('../../api/client', async original => {
  const actual = await original<typeof import('../../api/client')>();
  return { ...actual, api: { ...actual.api, ingestUnstructured: vi.fn(), getJob: vi.fn(), listJobs: vi.fn() } };
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.ingestUnstructured).mockResolvedValue(syntheticJob());
  vi.mocked(api.getJob).mockResolvedValue(syntheticJob());
  vi.mocked(api.listJobs).mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });
const flush = async (action?: () => void) => act(async () => { action?.(); });
const extract = () => flush(() => fireEvent.click(screen.getByRole('button', { name: 'Extract & Resolve' })));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { resolve, promise }; }
function Tracker({ initial }: { initial: Job }) {
  const tracking = useJobStatus(initial, true);
  return <><p>{tracking.job?.id}</p>{tracking.job && <JobStatus job={tracking.job} error={tracking.error} checking={tracking.checking} onCheck={tracking.checkAgain} />}</>;
}

it('failed AI -> close/reopen -> Try again preserves editable input and requires explicit submission', async () => {
  vi.mocked(api.getJob).mockResolvedValue(syntheticJob({ status: 'FAILED' }));
  const props = { onClose: vi.fn(), onCaseCreated: vi.fn(async () => {}) };
  const view = render(<AiExtractionModal isOpen {...props} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Synthetic test evidence' } });
  await extract();
  view.rerender(<AiExtractionModal isOpen={false} {...props} />);
  await flush(() => view.rerender(<AiExtractionModal isOpen {...props} />));
  await flush(() => fireEvent.click(screen.getByText('Try again')));
  expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Synthetic test evidence');
  expect(screen.getByRole('textbox').hasAttribute('disabled')).toBe(false);
  expect(api.ingestUnstructured).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Edited synthetic evidence' } });
  vi.mocked(api.ingestUnstructured).mockResolvedValue(syntheticJob({ id: 'job-2' }));
  vi.mocked(api.getJob).mockResolvedValue(syntheticJob({ id: 'job-2', status: 'SUCCEEDED', successful_rows: 1 }));
  await extract();
  expect(api.ingestUnstructured).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Completed')).toBeTruthy();
  expect(screen.queryByText('Try again')).toBeNull();
});

it('status error is visible and Check again only reads status, then resumes pending tracking', async () => {
  vi.mocked(api.getJob).mockRejectedValueOnce(Error('secret HTTP 504'));
  render(<AiExtractionModal isOpen onClose={vi.fn()} onCaseCreated={vi.fn(async () => {})} />);
  await extract();
  expect(screen.getByText(/Could not check the latest status/)).toBeTruthy();
  expect(screen.queryByText('Try again')).toBeNull();
  expect(screen.queryByText(/HTTP 504/)).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(api.getJob).toHaveBeenCalledTimes(1);
  await flush(() => fireEvent.click(screen.getByText('Check again')));
  expect(api.getJob).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(1800));
  expect(api.getJob).toHaveBeenCalledTimes(3);
  expect(api.ingestUnstructured).toHaveBeenCalledTimes(1);
});

it.each(['SUCCEEDED', 'FAILED'] as const)('Check again reads the durable %s outcome', async status => {
  vi.mocked(api.getJob).mockRejectedValueOnce(Error('read')).mockResolvedValueOnce(syntheticJob({ status }));
  render(<AiExtractionModal isOpen onClose={vi.fn()} onCaseCreated={vi.fn(async () => {})} />);
  await extract();
  await flush(() => fireEvent.click(screen.getByText('Check again')));
  expect(screen.getByText(status === 'SUCCEEDED' ? 'Completed' : 'Failed')).toBeTruthy();
  expect(api.ingestUnstructured).toHaveBeenCalledTimes(1);
});

it('Close invalidates an in-flight success response and reopening reads the same Job', async () => {
  const slow = deferred<Job>();
  vi.mocked(api.getJob).mockReturnValueOnce(slow.promise);
  const props = { onClose: vi.fn(), onCaseCreated: vi.fn(async () => {}) };
  const view = render(<AiExtractionModal isOpen {...props} />);
  await extract();
  await flush(() => view.rerender(<AiExtractionModal isOpen={false} {...props} />));
  await flush(() => slow.resolve(syntheticJob({ status: 'SUCCEEDED' })));
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(api.getJob).toHaveBeenCalledTimes(1);
  expect(props.onCaseCreated).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
  await flush(() => view.rerender(<AiExtractionModal isOpen {...props} />));
  expect(api.getJob).toHaveBeenCalledTimes(2);
  expect(api.ingestUnstructured).toHaveBeenCalledTimes(1);
});

it('Close cancels the scheduled modal poll timer', async () => {
  const props = { onClose: vi.fn(), onCaseCreated: vi.fn(async () => {}) };
  const view = render(<AiExtractionModal isOpen {...props} />);
  await extract();
  view.rerender(<AiExtractionModal isOpen={false} {...props} />);
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(api.getJob).toHaveBeenCalledTimes(1);
});

it('slow Job A response cannot overwrite tracking Job B', async () => {
  const slow = deferred<Job>();
  vi.mocked(api.getJob).mockReturnValueOnce(slow.promise).mockResolvedValueOnce(syntheticJob({ id: 'job-b', status: 'RUNNING' }));
  const view = render(<Tracker initial={syntheticJob({ id: 'job-a' })} />);
  await flush(() => view.rerender(<Tracker initial={syntheticJob({ id: 'job-b' })} />));
  await flush(() => slow.resolve(syntheticJob({ id: 'job-a', status: 'FAILED' })));
  expect(screen.getByText('job-b')).toBeTruthy();
  expect(screen.getByText('Running')).toBeTruthy();
  expect(screen.queryByText('Failed')).toBeNull();
});

it('old poll from a closed generation cannot overwrite an explicit new attempt after terminal failure', async () => {
  const slow = deferred<Job>();
  vi.mocked(api.getJob).mockReturnValueOnce(slow.promise).mockResolvedValueOnce(syntheticJob({ status: 'FAILED' }));
  const props = { onClose: vi.fn(), onCaseCreated: vi.fn(async () => {}) };
  const view = render(<AiExtractionModal isOpen {...props} />);
  await extract();
  view.rerender(<AiExtractionModal isOpen={false} {...props} />);
  await flush(() => view.rerender(<AiExtractionModal isOpen {...props} />));
  await flush(() => fireEvent.click(screen.getByText('Try again')));
  vi.mocked(api.ingestUnstructured).mockResolvedValueOnce(syntheticJob({ id: 'job-b' }));
  vi.mocked(api.getJob).mockResolvedValueOnce(syntheticJob({ id: 'job-b', status: 'RUNNING' }));
  await extract();
  await flush(() => slow.resolve(syntheticJob({ status: 'SUCCEEDED' })));
  expect(screen.getByText('Running')).toBeTruthy();
  expect(props.onCaseCreated).not.toHaveBeenCalled();
});

it.each(['PENDING', 'RUNNING', 'FAILED', 'SUCCEEDED'] as const)('reload retrieves a durable %s Job without creating work or reopening AI', async status => {
  const job = syntheticJob({ status, successful_rows: status === 'SUCCEEDED' ? 1 : 0 });
  vi.mocked(api.listJobs).mockResolvedValue([job]);
  vi.mocked(api.getJob).mockResolvedValue(job);
  const props = { workspaceId: 'test-workspace', revision: 0, expanded: true, onToggle: vi.fn() };
  const first = render(<RecentActivity {...props} />);
  await flush(); first.unmount();
  render(<RecentActivity {...props} />); await flush();
  expect(api.listJobs).toHaveBeenCalledTimes(2);
  expect(screen.getByText({ PENDING: 'Queued', RUNNING: 'Running', FAILED: 'Failed', SUCCEEDED: 'Completed' }[status])).toBeTruthy();
  expect(api.ingestUnstructured).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it.each(['PENDING', 'RUNNING'] as const)('old %s Job shows neutral delay message without changing the status', async status => {
  const job = syntheticJob({ status, created_at: new Date(Date.now() - 121000).toISOString() });
  vi.mocked(api.getJob).mockResolvedValue(job);
  render(<Tracker initial={job} />); await flush();
  expect(screen.getByText('This is taking longer than expected.')).toBeTruthy();
  expect(screen.getByText(status === 'PENDING' ? 'Queued' : 'Running')).toBeTruthy();
  expect(screen.getByText('Check again')).toBeTruthy();
  expect(job.status).toBe(status);
});

it('foreign workspace and investigation Jobs are excluded; safe result fields only', async () => {
  vi.mocked(api.listJobs).mockResolvedValue([
    syntheticJob({ workspace_id: 'foreign', status: 'FAILED', failure_message: 'FOREIGN SECRET' }),
    syntheticJob({ id: 'investigation', job_type: 'INVESTIGATION', status: 'SUCCEEDED' }),
    syntheticJob({ status: 'FAILED', failure_code: 'INTERNAL_ERROR', failure_message: 'SQL SECRET', source_label: 'raw evidence' }),
  ]);
  render(<RecentActivity workspaceId="test-workspace" revision={0} expanded onToggle={vi.fn()} />); await flush();
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  for (const text of ['SQL SECRET', 'FOREIGN SECRET', 'INTERNAL_ERROR', 'raw evidence']) expect(screen.queryByText(text)).toBeNull();
});

it('workspace switch rejects a slow former workspace list response', async () => {
  const slow = deferred<Job[]>();
  vi.mocked(api.listJobs).mockReturnValueOnce(slow.promise).mockResolvedValueOnce([]);
  const view = render(<RecentActivity key="a" workspaceId="a" revision={0} expanded onToggle={vi.fn()} />);
  await flush(() => view.rerender(<RecentActivity key="b" workspaceId="b" revision={0} expanded onToggle={vi.fn()} />));
  await flush(() => slow.resolve([syntheticJob({ workspace_id: 'a' })]));
  expect(screen.queryByText('AI evidence extraction')).toBeNull();
});

it('lists recent 20 terminal Jobs and retains older active Jobs', async () => {
  vi.mocked(api.listJobs).mockResolvedValue([...Array.from({ length: 25 }, (_, i) => syntheticJob({ id: `done-${i}`, status: 'SUCCEEDED' })), syntheticJob({ id: 'old-active' })]);
  vi.mocked(api.getJob).mockResolvedValue(syntheticJob({ id: 'old-active' }));
  render(<RecentActivity workspaceId="test-workspace" revision={0} expanded onToggle={vi.fn()} />); await flush();
  expect(screen.getAllByRole('listitem')).toHaveLength(21);
  expect(screen.getByText('Queued')).toBeTruthy();
});

it('activity completion clears the active count and does not keep polling a terminal Job', async () => {
  vi.mocked(api.listJobs).mockResolvedValue([syntheticJob()]);
  vi.mocked(api.getJob).mockRejectedValueOnce(Error('read')).mockResolvedValue(syntheticJob({ status: 'SUCCEEDED', successful_rows: 1 }));
  render(<RecentActivity workspaceId="test-workspace" revision={0} expanded onToggle={vi.fn()} />); await flush();
  const checks = screen.getAllByRole('button', { name: 'Check again' });
  await flush(() => fireEvent.click(checks[checks.length - 1]));
  expect(screen.getByText('Completed')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Recent activity' })).toBeTruthy();
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(api.getJob).toHaveBeenCalledTimes(2);
});

it('refreshing equivalent terminal Jobs with new response objects does not feed back old snapshots', async () => {
  vi.mocked(api.listJobs).mockResolvedValueOnce([syntheticJob({ status: 'SUCCEEDED' })])
    .mockResolvedValueOnce([syntheticJob({ status: 'SUCCEEDED' })]);
  const props = { workspaceId: 'test-workspace', expanded: true, onToggle: vi.fn() };
  const view = render(<RecentActivity {...props} revision={0} />); await flush();
  await flush(() => view.rerender(<RecentActivity {...props} revision={1} />));
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByText('Completed')).toBeTruthy();
  expect(api.getJob).not.toHaveBeenCalled();
});

it('an uncertain submission blocks another Extract; definite validation rejection stays editable', async () => {
  vi.mocked(api.ingestUnstructured).mockRejectedValueOnce(Error('lost acknowledgement'));
  const view = render(<AiExtractionModal isOpen onClose={vi.fn()} onCaseCreated={vi.fn(async () => {})} />);
  await extract();
  expect(screen.getByText(/could not confirm whether/)).toBeTruthy();
  expect(screen.getByText('Extract & Resolve').closest('button')?.disabled).toBe(true);
  expect(screen.queryByText('Try again')).toBeNull();
  view.unmount();
  vi.mocked(api.ingestUnstructured).mockRejectedValueOnce(new ApiError(422, 'unsafe detail'));
  render(<AiExtractionModal isOpen onClose={vi.fn()} onCaseCreated={vi.fn(async () => {})} />);
  await extract();
  expect(screen.getByText('Extract & Resolve').closest('button')?.disabled).toBe(false);
});

it('focus enters dialog, Escape closes, and focus returns to the trigger', async () => {
  const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
  const close = vi.fn();
  const view = render(<AiExtractionModal isOpen onClose={close} onCaseCreated={vi.fn(async () => {})} />);
  expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(close).toHaveBeenCalledTimes(1);
  view.rerender(<AiExtractionModal isOpen={false} onClose={close} onCaseCreated={vi.fn(async () => {})} />);
  expect(document.activeElement).toBe(trigger); trigger.remove();
});
