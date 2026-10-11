import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { InvestigationRun } from '../../types';
import { InvestigationPanel } from './InvestigationPanel';

const auth = vi.hoisted(() => ({ status: 'ready', workspace: { id: 'workspace-a' } }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => auth }));
vi.mock('../../api/client', () => ({ api: {
  listInvestigations: vi.fn(), getInvestigation: vi.fn(), startInvestigation: vi.fn(), resumeInvestigation: vi.fn(),
} }));
const run = (changes: Partial<InvestigationRun> = {}): InvestigationRun => ({
  id: 'run-a', case_id: 'case-a', status: 'RUNNING', outcome: null, current_step: 'inspect',
  last_error_message: null, interrupt: null, ...changes,
});
const waiting = run({ status: 'WAITING_FOR_HUMAN', interrupt: {
  reason: 'More evidence is needed', evidence_gap: 'PHONE', allowed_actions: ['STOP', 'RETRIEVE_SYNTHETIC_NOTES'],
} });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const flush = async (action?: () => void) => act(async () => { action?.(); });
const props = () => ({ caseId: 'case-a', eligible: true, onComplete: vi.fn() });
beforeEach(() => {
  vi.useFakeTimers(); auth.status = 'ready'; auth.workspace = { id: 'workspace-a' };
  vi.mocked(api.listInvestigations).mockResolvedValue([]);
  vi.mocked(api.startInvestigation).mockResolvedValue(run());
  vi.mocked(api.resumeInvestigation).mockResolvedValue(run());
  vi.mocked(api.getInvestigation).mockResolvedValue(waiting);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });

it('starts once while pending, polls the accepted run, and waits for human input', async () => {
  const accepted = deferred<InvestigationRun>();
  vi.mocked(api.startInvestigation).mockReturnValue(accepted.promise);
  const p = props(); render(<InvestigationPanel {...p} />); await flush();
  const start = screen.getByRole('button', { name: 'Start evidence investigation' });
  await flush(() => fireEvent.click(start));
  await flush(() => fireEvent.click(start));
  expect(start.hasAttribute('disabled')).toBe(true);
  expect(api.startInvestigation).toHaveBeenCalledExactlyOnceWith('case-a');
  await flush(() => accepted.resolve(run()));
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(api.getInvestigation).toHaveBeenCalledExactlyOnceWith('run-a');
  expect(screen.getByRole('status').textContent).toBe('WAITING FOR HUMAN');
  expect(screen.getByText(/More evidence is needed/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Start evidence investigation' })).toBeNull();
  expect(p.onComplete).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(api.getInvestigation).toHaveBeenCalledTimes(1);
});

it.each(['STOP', 'RETRIEVE_SYNTHETIC_NOTES'] as const)('resumes the existing checkpoint once with %s', async action => {
  vi.mocked(api.listInvestigations).mockResolvedValue([waiting]);
  const resumed = deferred<InvestigationRun>();
  vi.mocked(api.resumeInvestigation).mockReturnValue(resumed.promise);
  render(<InvestigationPanel {...props()} />); await flush();
  const choice = screen.getByRole('button', { name: action === 'STOP' ? 'Finish investigation; return to review' : 'Retrieve synthetic notes and resume' });
  await flush(() => fireEvent.click(choice));
  await flush(() => fireEvent.click(choice));
  for (const button of screen.getAllByRole('button')) expect(button.hasAttribute('disabled')).toBe(true);
  expect(api.resumeInvestigation).toHaveBeenCalledExactlyOnceWith('run-a', action);
  expect(api.startInvestigation).not.toHaveBeenCalled();
  await flush(() => resumed.resolve(run({ status: action === 'STOP' ? 'SUCCEEDED' : 'RUNNING' })));
  expect(screen.getByRole('status').textContent).toBe(action === 'STOP' ? 'SUCCEEDED' : 'RUNNING');
});

it.each(['RUNNING', 'WAITING_FOR_HUMAN', 'SUCCEEDED', 'FAILED'] as const)('restores durable %s state after remount without submitting work', async status => {
  const saved = status === 'WAITING_FOR_HUMAN' ? waiting : run({ status, outcome: status === 'SUCCEEDED' ? 'EVIDENCE_COMPLETE' : null });
  vi.mocked(api.listInvestigations).mockResolvedValue([saved]);
  const p = props(); const view = render(<InvestigationPanel {...p} />); await flush(); view.unmount();
  render(<InvestigationPanel {...p} />); await flush();
  expect(api.listInvestigations).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('status').textContent).toContain(status.replaceAll('_', ' '));
  expect(screen.getByText(/final review decision stays with you/)).toBeTruthy();
  expect(api.startInvestigation).not.toHaveBeenCalled(); expect(api.resumeInvestigation).not.toHaveBeenCalled();
  if (status === 'SUCCEEDED' || status === 'FAILED') {
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(api.getInvestigation).not.toHaveBeenCalled();
  }
});

it('renders failed run details and an unavailable initial history distinctly', async () => {
  vi.mocked(api.listInvestigations).mockResolvedValueOnce([run({ status: 'FAILED', last_error_message: 'Synthetic retrieval failed' })]);
  const view = render(<InvestigationPanel {...props()} />); await flush();
  expect(screen.getByRole('status').textContent).toBe('FAILED');
  expect(screen.getByText('Synthetic retrieval failed')).toBeTruthy(); view.unmount();
  vi.mocked(api.listInvestigations).mockRejectedValueOnce(Error('offline'));
  render(<InvestigationPanel {...props()} />); await flush();
  expect(screen.getByRole('alert').textContent).toBe('Could not load investigations.');
  expect(screen.queryByRole('status')).toBeNull();
  expect(api.startInvestigation).not.toHaveBeenCalled();
});

it('status read failure retries the same run without starting or resuming work', async () => {
  vi.mocked(api.listInvestigations).mockResolvedValue([run()]);
  vi.mocked(api.getInvestigation).mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(run({ status: 'SUCCEEDED' }));
  const p = props(); render(<InvestigationPanel {...p} />); await flush();
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(screen.getByRole('alert').textContent).toContain('Could not check investigation status');
  expect(screen.getByRole('status').textContent).toBe('RUNNING');
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(screen.getByRole('status').textContent).toBe('SUCCEEDED');
  expect(api.getInvestigation).toHaveBeenCalledTimes(2);
  expect(api.startInvestigation).not.toHaveBeenCalled(); expect(api.resumeInvestigation).not.toHaveBeenCalled();
  expect(p.onComplete).toHaveBeenCalledTimes(1);
});

it.each(['case', 'workspace', 'unmount'])('discards slow investigation state after %s changes', async change => {
  const slow = deferred<InvestigationRun[]>();
  vi.mocked(api.listInvestigations).mockReturnValueOnce(slow.promise).mockResolvedValue([]);
  const p = props(); const view = render(<InvestigationPanel {...p} />); await flush();
  if (change === 'unmount') view.unmount();
  else {
    if (change === 'workspace') auth.workspace = { id: 'workspace-b' };
    view.rerender(<InvestigationPanel {...p} caseId={change === 'case' ? 'case-b' : 'case-a'} />);
  }
  await flush(() => slow.resolve([waiting]));
  expect(screen.queryByText('WAITING FOR HUMAN')).toBeNull(); expect(p.onComplete).not.toHaveBeenCalled();
});
