import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { api, ApiError } from './api/client';
import { workspaceDetail, emptyCandidateDetail, summaryFor } from './test-support/case-workspace';
import type { CaseDetail } from './types';

const auth = vi.hoisted(() => ({ status: 'ready', workspace: { id: 'review-experience', role: 'OWNER' }, signOutUser: vi.fn(async () => {}) }));
vi.mock('./auth/AuthProvider', () => ({ useAuth: () => auth }));
vi.mock('./api/telemetry', () => ({ recordUsageEvent: vi.fn() }));
vi.mock('./api/client', async original => {
  const actual = await original<typeof import('./api/client')>();
  return { ...actual, api: Object.fromEntries(Object.keys(actual.api).map(key => [key, vi.fn()])) };
});
// Exercise the existing CaseDetail refresh callback without running a backend investigation.
vi.mock('./components/cases/InvestigationPanel', () => ({ InvestigationPanel: ({ onComplete }: { onComplete?: () => void }) => <button onClick={onComplete}>Synthetic Case refresh</button> }));
const review = () => within(screen.getByRole('region', { name: 'Your review' }));
const accept = () => review().getByRole('button', { name: /Accept Candidate/ });
const select = (number: string) => fireEvent.click(screen.getByRole('button', { name: new RegExp(number) }));
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  auth.status = 'ready'; auth.workspace = { id: 'review-experience', role: 'OWNER' };
  vi.mocked(api.listJobs).mockResolvedValue([]);
  vi.mocked(api.getCases).mockResolvedValue([summaryFor(workspaceDetail), summaryFor(emptyCandidateDetail)]);
  vi.mocked(api.getCase).mockImplementation(async id => id === workspaceDetail.id ? workspaceDetail : emptyCandidateDetail);
  vi.mocked(api.submitDecision).mockImplementation(async (id, payload) => ({ ...(id === workspaceDetail.id ? workspaceDetail : emptyCandidateDetail),
    review_decision: payload.decision, selected_candidate_id: payload.selected_candidate_id ?? null, reviewer_notes: payload.notes ?? null }));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('retains a note while switching immediately before acceptance and restores authoritative readback', async () => {
  render(<App />); await screen.findByRole('heading', { name: workspaceDetail.raw_name });
  fireEvent.change(screen.getByLabelText('Reviewer note (optional)'), { target: { value: 'Synthetic suffix evidence checked' } });
  fireEvent.click(screen.getByRole('button', { name: /Candidate B/ })); fireEvent.click(accept());
  await waitFor(() => expect(api.submitDecision).toHaveBeenCalledExactlyOnceWith(workspaceDetail.id, { decision: 'ACCEPTED', selected_candidate_id: 'candidate-alternate', notes: 'Synthetic suffix evidence checked' }));
  await waitFor(() => expect(review().getByText('Saved candidate: Claire Reynolds Sr.')).toBeTruthy());
  expect(review().getByText('Accepted')).toBeTruthy();
  expect(screen.getByRole('button', { name: /Candidate B/ }).getAttribute('aria-pressed')).toBe('true');
});
it('protects the intended write and note when the Case refreshes during an in-flight review', async () => {
  const pending = deferred<CaseDetail>(); vi.mocked(api.submitDecision).mockReturnValue(pending.promise);
  render(<App />); await screen.findByRole('heading', { name: workspaceDetail.raw_name });
  fireEvent.change(screen.getByLabelText('Reviewer note (optional)'), { target: { value: 'Synthetic captured note' } });
  fireEvent.click(accept()); fireEvent.click(screen.getByRole('button', { name: 'Synthetic Case refresh' }));
  await screen.findByRole('heading', { name: workspaceDetail.raw_name });
  expect(accept().hasAttribute('disabled')).toBe(true); fireEvent.click(accept());
  expect(api.submitDecision).toHaveBeenCalledExactlyOnceWith(workspaceDetail.id, { decision: 'ACCEPTED', selected_candidate_id: 'candidate-1', notes: 'Synthetic captured note' });
  await act(async () => pending.resolve({ ...workspaceDetail, review_decision: 'ACCEPTED', selected_candidate_id: 'candidate-1', reviewer_notes: 'Synthetic captured note' }));
  expect(review().getByText('Saved candidate: Claire Reynolds Jr.')).toBeTruthy();
  expect((screen.getByLabelText('Reviewer note (optional)') as HTMLTextAreaElement).value).toBe('Synthetic captured note');
});
it('keeps the existing REVIEWER role eligible for all review actions', async () => {
  auth.workspace.role = 'REVIEWER'; render(<App />); await screen.findByRole('heading', { name: workspaceDetail.raw_name });
  for (const name of [/Accept Candidate/, /Reject All/, /Need More Evidence/]) expect(review().getByRole('button', { name }).hasAttribute('disabled')).toBe(false);
  expect(api.submitDecision).not.toHaveBeenCalled();
});
it('announces denied workspace access once and never turns recovery into another write', async () => {
  vi.mocked(api.submitDecision).mockRejectedValue(new ApiError(403, 'Workspace access is denied.'));
  render(<App />); await screen.findByRole('heading', { name: workspaceDetail.raw_name }); fireEvent.click(accept());
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('workspace access could not be verified'));
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  for (const name of [/Accept Candidate/, /Reject All/, /Need More Evidence/]) expect(review().getByRole('button', { name }).hasAttribute('disabled')).toBe(true);
  vi.mocked(api.getCase).mockRejectedValue(new ApiError(403, 'Workspace access is denied.'));
  fireEvent.click(review().getByRole('button', { name: 'Check saved decision' }));
  await screen.findByText('Workspace access is denied.');
  expect(accept().hasAttribute('disabled')).toBe(true);
  expect(api.submitDecision).toHaveBeenCalledTimes(1);
});
it('does not clear a late uncertainty lock with a read that started before the failure', async () => {
  const pending = deferred<CaseDetail>(); const oldRead = deferred<CaseDetail>();
  vi.mocked(api.submitDecision).mockReturnValue(pending.promise);
  render(<App />); await screen.findByRole('heading', { name: workspaceDetail.raw_name }); fireEvent.click(accept());
  select(emptyCandidateDetail.case_number); await screen.findByRole('heading', { name: emptyCandidateDetail.raw_name });
  vi.mocked(api.getCase).mockReturnValue(oldRead.promise); select(workspaceDetail.case_number);
  await screen.findByText('Loading case details...');
  await act(async () => pending.reject(new Error('Synthetic uncertain write')));
  await act(async () => oldRead.resolve(workspaceDetail));
  expect(screen.getByRole('heading', { name: 'Case details unavailable' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Accept Candidate' }).hasAttribute('disabled')).toBe(true);
  vi.mocked(api.getCase).mockResolvedValue({ ...workspaceDetail, review_decision: 'ACCEPTED', selected_candidate_id: 'candidate-1', reviewer_notes: 'Saved note' });
  fireEvent.click(screen.getByRole('button', { name: 'Retry selected case' }));
  await waitFor(() => expect(review().getByText('Accepted')).toBeTruthy());
  expect(api.submitDecision).toHaveBeenCalledTimes(1);
});
it('requires an authoritative read before resubmitting an unknown write and preserves the saved note', async () => {
  vi.mocked(api.submitDecision).mockRejectedValue(new Error('Synthetic response lost'));
  render(<App />); await screen.findByRole('heading', { name: workspaceDetail.raw_name }); fireEvent.click(accept());
  await screen.findByText(/Could not confirm the review decision/);
  expect(accept().hasAttribute('disabled')).toBe(true); fireEvent.click(accept()); expect(api.submitDecision).toHaveBeenCalledTimes(1);
  vi.mocked(api.getCase).mockResolvedValue({ ...workspaceDetail, review_decision: 'ACCEPTED', selected_candidate_id: 'candidate-1', reviewer_notes: 'Authoritative saved note' });
  fireEvent.click(review().getByRole('button', { name: 'Check saved decision' }));
  await waitFor(() => expect(review().getByText('Accepted')).toBeTruthy());
  expect((screen.getByLabelText('Reviewer note (optional)') as HTMLTextAreaElement).value).toBe('Authoritative saved note');
  expect(api.submitDecision).toHaveBeenCalledTimes(1);
});
it('locks the same Case after a late uncertain result across A to B to A navigation', async () => {
  const pending = deferred<CaseDetail>(); vi.mocked(api.submitDecision).mockReturnValue(pending.promise);
  render(<App />); await screen.findByRole('heading', { name: workspaceDetail.raw_name }); fireEvent.click(accept());
  select(emptyCandidateDetail.case_number); await screen.findByRole('heading', { name: emptyCandidateDetail.raw_name });
  select(workspaceDetail.case_number); await screen.findByRole('heading', { name: workspaceDetail.raw_name });
  await act(async () => pending.reject(new Error('Synthetic late response lost')));
  expect(accept().hasAttribute('disabled')).toBe(true);
  expect(review().getByRole('button', { name: 'Check saved decision' })).toBeTruthy();
  fireEvent.click(accept()); expect(api.submitDecision).toHaveBeenCalledTimes(1);
});
