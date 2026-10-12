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
  reason: 'More evidence is needed', evidence_gap: 'missing_phone', allowed_actions: ['STOP', 'RETRIEVE_SYNTHETIC_NOTES'],
} });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const flush = async (action?: () => void) => act(async () => { action?.(); });
const tick = async () => act(async () => vi.advanceTimersByTimeAsync(1500));
const props = () => ({ caseId: 'case-a', eligible: true, onComplete: vi.fn() });
const labels = { PENDING: 'Queued', RUNNING: 'Running', WAITING_FOR_HUMAN: 'Waiting for your input', SUCCEEDED: 'Completed', FAILED: 'Failed' };
let session = 0;
beforeEach(() => {
  vi.useFakeTimers(); auth.status = 'ready'; auth.workspace = { id: `workspace-${++session}` };
  vi.mocked(api.listInvestigations).mockResolvedValue([]);
  vi.mocked(api.startInvestigation).mockResolvedValue(run());
  vi.mocked(api.resumeInvestigation).mockResolvedValue(run());
  vi.mocked(api.getInvestigation).mockResolvedValue(waiting);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });

it('starts once, announces acceptance, then reads an authoritative checkpoint', async () => {
  const accepted = deferred<InvestigationRun>(); vi.mocked(api.startInvestigation).mockReturnValue(accepted.promise);
  const p = props(); render(<InvestigationPanel {...p} />); await flush();
  const start = screen.getByRole('button', { name: 'Start evidence investigation' });
  await flush(() => { fireEvent.click(start); fireEvent.click(start); });
  expect(start.hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('status').textContent).toBe('Starting investigation');
  expect(screen.getByRole('heading', { name: 'Evidence investigation' })).toBe(document.activeElement);
  expect(api.startInvestigation).toHaveBeenCalledExactlyOnceWith('case-a');
  await flush(() => accepted.resolve(run()));
  expect(screen.getByRole('status').textContent).toBe('Start accepted; checking status');
  expect(p.onComplete).not.toHaveBeenCalled(); await tick();
  expect(api.getInvestigation).toHaveBeenCalledExactlyOnceWith('run-a');
  expect(screen.getByRole('status').textContent).toBe('Waiting for your input');
  expect(screen.getByText('More evidence is needed')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Start evidence investigation' })).toBeNull();
  expect(p.onComplete).toHaveBeenCalledTimes(1); await tick(); expect(api.getInvestigation).toHaveBeenCalledTimes(1);
});

it.each(['STOP', 'RETRIEVE_SYNTHETIC_NOTES'] as const)('continues once with %s and reads back before confirming a result', async action => {
  vi.mocked(api.listInvestigations).mockResolvedValue([waiting]);
  const resumed = deferred<InvestigationRun>(); vi.mocked(api.resumeInvestigation).mockReturnValue(resumed.promise);
  const p = props(); render(<InvestigationPanel {...p} />); await flush();
  const choice = screen.getByRole('button', { name: action === 'STOP' ? 'Finish investigation; return to review' : 'Retrieve synthetic notes and resume' });
  await flush(() => { fireEvent.click(choice); fireEvent.click(choice); });
  for (const button of screen.getAllByRole('button')) expect(button.hasAttribute('disabled')).toBe(true);
  expect(api.resumeInvestigation).toHaveBeenCalledExactlyOnceWith('run-a', action); expect(api.startInvestigation).not.toHaveBeenCalled();
  const result = run({ status: action === 'STOP' ? 'SUCCEEDED' : 'RUNNING' });
  await flush(() => resumed.resolve(result));
  expect(screen.getByRole('status').textContent).toBe('Continuation accepted; checking status');
  expect(screen.queryByText(/Investigation completed/)).toBeNull(); expect(p.onComplete).not.toHaveBeenCalled();
  vi.mocked(api.getInvestigation).mockResolvedValueOnce(result); await tick();
  expect(screen.getByRole('status').textContent).toBe(labels[result.status]);
  if (action === 'STOP') expect(screen.getByText(/Completion does not mean a human has accepted/)).toBeTruthy();
});

it.each(['PENDING', 'RUNNING', 'WAITING_FOR_HUMAN', 'SUCCEEDED', 'FAILED'] as const)('restores durable %s without writing', async status => {
  const saved = status === 'WAITING_FOR_HUMAN' ? waiting : run({ status, outcome: status === 'SUCCEEDED' ? 'EVIDENCE_COMPLETE' : null });
  vi.mocked(api.listInvestigations).mockResolvedValue([saved]);
  const p = props(); const view = render(<InvestigationPanel {...p} />); await flush(); view.unmount();
  render(<InvestigationPanel {...p} />); await flush();
  expect(api.listInvestigations).toHaveBeenCalledTimes(2); expect(screen.getByRole('status').textContent).toBe(labels[status]);
  expect(screen.getByText(/final Case review decision stays with you/)).toBeTruthy();
  expect(api.startInvestigation).not.toHaveBeenCalled(); expect(api.resumeInvestigation).not.toHaveBeenCalled();
  if (['SUCCEEDED', 'FAILED', 'WAITING_FOR_HUMAN'].includes(status)) { await tick(); expect(api.getInvestigation).not.toHaveBeenCalled(); }
});

it('distinguishes failure from unavailable history and blocks start until a successful read', async () => {
  vi.mocked(api.listInvestigations).mockResolvedValueOnce([run({ status: 'FAILED', last_error_message: 'Synthetic retrieval failed' })]);
  const view = render(<InvestigationPanel {...props()} />); await flush();
  expect(screen.getByRole('status').textContent).toBe('Failed'); expect(screen.getByText('Synthetic retrieval failed')).toBeTruthy(); view.unmount();
  vi.mocked(api.listInvestigations).mockRejectedValueOnce(Error('offline'));
  render(<InvestigationPanel {...props()} />); await flush();
  expect(screen.getByRole('alert').textContent).toContain('Could not check investigation status');
  expect(screen.getByRole('status').textContent).toBe('Status unconfirmed');
  expect(screen.getByRole('button', { name: 'Start evidence investigation' }).hasAttribute('disabled')).toBe(true);
  await flush(() => fireEvent.click(screen.getByRole('button', { name: 'Refresh investigation status' })));
  expect(screen.getByRole('status').textContent).toBe('Not started'); expect(screen.queryByRole('alert')).toBeNull(); expect(api.startInvestigation).not.toHaveBeenCalled();
});

it('retries only reads through repeated failures and clears uncertainty on an authoritative result', async () => {
  vi.mocked(api.listInvestigations).mockResolvedValue([run()]);
  vi.mocked(api.getInvestigation).mockRejectedValueOnce(Error('offline')).mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(run({ status: 'SUCCEEDED' }));
  const p = props(); render(<InvestigationPanel {...p} />); await flush(); await tick();
  expect(screen.getByRole('status').textContent).toBe('Status unconfirmed'); expect(screen.getByText('Running', { exact: true })).toBeTruthy();
  await tick(); await tick(); expect(screen.getByRole('status').textContent).toBe('Completed'); expect(screen.queryByRole('alert')).toBeNull();
  expect(api.getInvestigation).toHaveBeenCalledTimes(3); expect(api.startInvestigation).not.toHaveBeenCalled(); expect(api.resumeInvestigation).not.toHaveBeenCalled();
  expect(p.onComplete).toHaveBeenCalledTimes(1);
});

it.each(['case', 'workspace', 'unmount'])('discards slow history after %s changes', async change => {
  const slow = deferred<InvestigationRun[]>(); vi.mocked(api.listInvestigations).mockReturnValueOnce(slow.promise).mockResolvedValue([]);
  const p = props(); const view = render(<InvestigationPanel {...p} />); await flush();
  if (change === 'unmount') view.unmount();
  else { if (change === 'workspace') auth.workspace = { id: 'workspace-other' }; view.rerender(<InvestigationPanel {...p} caseId={change === 'case' ? 'case-b' : 'case-a'} />); }
  await flush(() => slow.resolve([waiting])); expect(screen.queryByText('Waiting for your input')).toBeNull(); expect(p.onComplete).not.toHaveBeenCalled();
});

it.each(['start', 'resume'])('keeps pending %s locked through switching away and remounting', async kind => {
  if (kind === 'resume') vi.mocked(api.listInvestigations).mockResolvedValue([waiting]);
  const pending = deferred<InvestigationRun>(); vi.mocked(kind === 'start' ? api.startInvestigation : api.resumeInvestigation).mockReturnValue(pending.promise);
  const p = props(); const view = render(<InvestigationPanel {...p} />); await flush();
  await flush(() => fireEvent.click(screen.getByRole('button', { name: kind === 'start' ? 'Start evidence investigation' : 'Retrieve synthetic notes and resume' })));
  view.unmount(); const other = render(<InvestigationPanel {...p} caseId="case-b" />); await flush();
  await flush(() => pending.resolve(run())); expect(screen.queryByText(/accepted; checking/)).toBeNull(); expect(p.onComplete).not.toHaveBeenCalled(); other.unmount();
  render(<InvestigationPanel {...p} />); await flush(); expect(screen.getByRole('status').textContent).toContain('accepted; checking status');
  await tick(); expect(screen.getByRole('status').textContent).toBe('Waiting for your input');
  expect(kind === 'start' ? api.startInvestigation : api.resumeInvestigation).toHaveBeenCalledTimes(1);
});

it.each(['start', 'resume'])('never retries uncertain %s after an unchanged read or remount', async kind => {
  if (kind === 'resume') vi.mocked(api.listInvestigations).mockResolvedValue([waiting]);
  vi.mocked(kind === 'start' ? api.startInvestigation : api.resumeInvestigation).mockRejectedValue(Error('Network interrupted'));
  const p = props(); const view = render(<InvestigationPanel {...p} />); await flush();
  const name = kind === 'start' ? 'Start evidence investigation' : 'Retrieve synthetic notes and resume';
  await flush(() => fireEvent.click(screen.getByRole('button', { name })));
  expect(screen.getByRole('alert').textContent).toContain('Could not confirm whether the request was accepted');
  await tick(); expect(api.getInvestigation).not.toHaveBeenCalled();
  await flush(() => fireEvent.click(screen.getByRole('button', { name: 'Refresh investigation status' })));
  expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true);
  view.unmount(); render(<InvestigationPanel {...p} />); await flush(); expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true);
  expect(kind === 'start' ? api.startInvestigation : api.resumeInvestigation).toHaveBeenCalledTimes(1);
  if (kind === 'start') vi.mocked(api.listInvestigations).mockResolvedValueOnce([run()]); else vi.mocked(api.getInvestigation).mockResolvedValueOnce(run());
  await flush(() => fireEvent.click(screen.getByRole('button', { name: 'Refresh investigation status' })));
  expect(screen.getByRole('status').textContent).toBe('Running');
});

it('disables actions without an authorized session', async () => {
  vi.mocked(api.listInvestigations).mockResolvedValue([waiting]); const p = props(); const view = render(<InvestigationPanel {...p} />); await flush();
  auth.status = 'signed_out'; view.rerender(<InvestigationPanel {...p} />); await flush();
  for (const button of screen.getAllByRole('button')) expect(button.hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('status').textContent).toBe('Investigation unavailable'); expect(api.startInvestigation).not.toHaveBeenCalled(); expect(api.resumeInvestigation).not.toHaveBeenCalled();
});

it('shows only supported checkpoint actions and blocks an ineligible start', async () => {
  const view = render(<InvestigationPanel {...props()} eligible={false} />); await flush(); expect(screen.queryByRole('button', { name: 'Start evidence investigation' })).toBeNull(); view.unmount();
  vi.mocked(api.listInvestigations).mockResolvedValue([{ ...waiting, interrupt: { ...waiting.interrupt!, allowed_actions: ['STOP', 'UNSUPPORTED'] } }]);
  render(<InvestigationPanel {...props()} />); await flush(); expect(screen.getByRole('button', { name: 'Finish investigation; return to review' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retrieve synthetic notes and resume' })).toBeNull(); expect(screen.queryByRole('button', { name: /UNSUPPORTED|Pause/ })).toBeNull();
});

it('rejects another Case response without exposing evidence or permitting writes', async () => {
  vi.mocked(api.listInvestigations).mockResolvedValue([{ ...waiting, case_id: 'case-b' }]); render(<InvestigationPanel {...props()} />); await flush();
  expect(screen.getByRole('alert').textContent).toContain('does not match this Case'); expect(screen.queryByText('More evidence is needed')).toBeNull();
  expect(screen.getByRole('button', { name: 'Start evidence investigation' }).hasAttribute('disabled')).toBe(true);
});

it.each(['case', 'workspace', 'unmount'])('ignores an in-flight status result after %s changes', async change => {
  const slow = deferred<InvestigationRun>();
  vi.mocked(api.listInvestigations).mockResolvedValueOnce([run()]).mockResolvedValue([]);
  vi.mocked(api.getInvestigation).mockReturnValueOnce(slow.promise);
  const p = props(); const view = render(<InvestigationPanel {...p} />); await flush(); await tick();
  if (change === 'unmount') view.unmount();
  else {
    if (change === 'workspace') auth.workspace = { id: 'other-status-workspace' };
    view.rerender(<InvestigationPanel {...p} caseId={change === 'case' ? 'case-b' : 'case-a'} />); await flush();
  }
  await flush(() => slow.resolve(run({ status: 'SUCCEEDED', outcome: 'EVIDENCE_COMPLETE' })));
  expect(screen.queryByText('Completed')).toBeNull(); expect(screen.queryByText('EVIDENCE COMPLETE')).toBeNull();
  expect(p.onComplete).not.toHaveBeenCalled(); expect(api.startInvestigation).not.toHaveBeenCalled(); expect(api.resumeInvestigation).not.toHaveBeenCalled();
});
