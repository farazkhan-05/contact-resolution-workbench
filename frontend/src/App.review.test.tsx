import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { api } from './api/client';
import { sampleDetail, sampleSummary } from './test-support/cases';
import type { CaseDetail, ReviewDecision } from './types';

const auth = vi.hoisted(() => ({
  status: 'ready', workspace: { id: 'review-test-workspace', role: 'OWNER' },
  signOutUser: vi.fn(async () => {}),
}));
vi.mock('./auth/AuthProvider', () => ({ useAuth: () => auth }));
vi.mock('./api/telemetry', () => ({ recordUsageEvent: vi.fn() }));
vi.mock('./api/client', async (original) => {
  const actual = await original<typeof import('./api/client')>();
  return { ...actual, api: Object.fromEntries(Object.keys(actual.api).map(key => [key, vi.fn()])) };
});

const caseA = sampleDetail;
const caseB: CaseDetail = {
  ...sampleDetail, id: 'case-2', case_number: 'SAMPLE-002', raw_name: 'Synthetic Reviewer B',
  candidates: [{ ...sampleDetail.candidates[0], id: 'candidate-2', name: 'Synthetic Candidate B' }],
};
const summaries = [sampleSummary, {
  ...sampleSummary, id: caseB.id, case_number: caseB.case_number, person_name: caseB.raw_name,
}];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const select = (caseNumber: string) => fireEvent.click(screen.getByRole('button', { name: new RegExp(caseNumber) }));
const heading = (detail: CaseDetail) => screen.getByRole('heading', { name: detail.raw_name });
const rejectButton = () => screen.getByRole('button', { name: 'Reject All' });

beforeEach(() => {
  vi.mocked(api.listJobs).mockResolvedValue([]);
  vi.mocked(api.getCases).mockResolvedValue(summaries);
  vi.mocked(api.getCase).mockImplementation(async id => id === caseA.id ? caseA : caseB);
  vi.mocked(api.listInvestigations).mockResolvedValue([]);
  vi.mocked(api.submitDecision).mockImplementation(async (id, payload) => ({
    ...(id === caseA.id ? caseA : caseB), review_decision: payload.decision,
    selected_candidate_id: payload.selected_candidate_id ?? null, reviewer_notes: payload.notes ?? null,
  }));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('review case authority', () => {
  it('candidate switching replaces conflicts, evidence, and the identity submitted for acceptance', async () => {
    const alternate = { ...caseA.candidates[0], id: 'alternate', name: 'Synthetic Alternate',
      contradictions: [{ id: 'suffix-conflict', contradiction_type: 'INCOMPATIBLE_NAME_SUFFIX', severity: 'SERIOUS' as const,
        description: 'Synthetic incompatible suffix: Jr. versus Sr.', blocks_likely_match: true }], has_serious_contradiction: true,
      evidence: [{ ...caseA.candidates[0].evidence[0], id: 'alternate-name', candidate_value: 'Synthetic Alternate', explanation: 'Alternate-specific evidence' }],
    };
    vi.mocked(api.getCase).mockResolvedValue({ ...caseA, candidates: [caseA.candidates[0], alternate] });
    render(<App />); await screen.findByRole('heading', { name: caseA.raw_name });
    await waitFor(() => expect(screen.getByRole('button', { name: /Candidate A/ }).textContent).toContain('Active'));
    fireEvent.click(screen.getByRole('button', { name: /Candidate B/ }));
    expect(screen.getByText('Synthetic incompatible suffix: Jr. versus Sr.')).toBeTruthy();
    expect(screen.getByText('Alternate-specific evidence')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Accept Candidate/ }).textContent).toContain('Synthetic Alternate');
    fireEvent.click(screen.getByRole('button', { name: /Candidate A/ }));
    expect(screen.queryByText('Synthetic incompatible suffix: Jr. versus Sr.')).toBeNull();
    expect(screen.queryByText('Alternate-specific evidence')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Candidate B/ }));
    fireEvent.click(screen.getByRole('button', { name: /Accept Candidate/ }));
    await waitFor(() => expect(api.submitDecision).toHaveBeenCalledExactlyOnceWith(caseA.id, {
      decision: 'ACCEPTED', selected_candidate_id: 'alternate', notes: '',
    }));
  });

  it('detail read-back selects the saved candidate and restores notes without changing system advice', async () => {
    const acceptedCandidate = { ...caseA.candidates[0], id: 'saved', name: 'Saved Candidate' };
    vi.mocked(api.getCase).mockResolvedValue({ ...caseA, routing_status: 'NEEDS_REVIEW', review_decision: 'ACCEPTED',
      selected_candidate_id: 'saved', reviewer_notes: 'Saved synthetic note', candidates: [caseA.candidates[0], acceptedCandidate] });
    render(<App />); await screen.findByRole('button', { name: 'Accept Candidate (Saved Candidate)' });
    expect(within(screen.getByRole('region', { name: 'Recommendation and human decision' })).getByText('Needs review')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Recommendation and human decision' })).getByText('Accepted')).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reviewer Operational Note (Optional)').value).toBe('Saved synthetic note');
    expect(api.submitDecision).not.toHaveBeenCalled();
    vi.mocked(api.getCase).mockResolvedValue(caseB);
    select(caseB.case_number); await screen.findByRole('heading', { name: caseB.raw_name });
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reviewer Operational Note (Optional)').value).toBe('');
    expect(screen.queryByText('Current Verdict: ACCEPTED (Candidate Accepted)')).toBeNull();
  });

  it('keeps B displayed when slow A detail completes after B', async () => {
    const slowA = deferred<CaseDetail>();
    vi.mocked(api.getCase).mockImplementation(id => id === caseA.id ? slowA.promise : Promise.resolve(caseB));
    render(<App />);
    await waitFor(() => expect(api.getCase).toHaveBeenCalledWith(caseA.id));
    select(caseB.case_number);
    await screen.findByRole('heading', { name: caseB.raw_name });
    await act(async () => slowA.resolve(caseA));
    expect(heading(caseB)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: caseA.raw_name })).toBeNull();
  });

  it.each([
    ['ACCEPTED', /Accept Candidate/, 'candidate-2'],
    ['REJECTED', /Reject All/, null],
    ['NEED_MORE_EVIDENCE', /Need More Evidence/, null],
  ] as const)('rapid A to B selection binds %s to B only', async (decision, buttonName, candidateId) => {
    const slowA = deferred<CaseDetail>();
    vi.mocked(api.getCase).mockImplementation(id => id === caseA.id ? slowA.promise : Promise.resolve(caseB));
    render(<App />);
    await waitFor(() => expect(api.getCase).toHaveBeenCalledWith(caseA.id));
    select(caseB.case_number);
    await screen.findByRole('heading', { name: caseB.raw_name });
    await act(async () => slowA.resolve(caseA));
    fireEvent.click(screen.getByRole('button', { name: buttonName }));
    await waitFor(() => expect(api.submitDecision).toHaveBeenCalledTimes(1));
    expect(api.submitDecision).toHaveBeenCalledWith(caseB.id, {
      decision, selected_candidate_id: candidateId, notes: '',
    });
    await screen.findByText(`Current Verdict: ${decision}${candidateId ? ' (Candidate Accepted)' : ''}`);
    expect(heading(caseB)).toBeTruthy();
  });

  it('hides previous evidence and disables review when selected B failed to load', async () => {
    vi.mocked(api.getCase).mockImplementation(id => id === caseA.id
      ? Promise.resolve(caseA) : Promise.reject(new Error('Synthetic B detail failure')));
    render(<App />);
    await screen.findByRole('heading', { name: caseA.raw_name });
    select(caseB.case_number);
    await screen.findByText('Could not load case detail.');
    expect(screen.queryByRole('heading', { name: caseA.raw_name })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Case details unavailable' })).toBeTruthy();
    for (const name of [/Accept Candidate/, /Reject All/, /Need More Evidence/]) {
      const button = screen.getByRole('button', { name });
      expect(button.hasAttribute('disabled')).toBe(true);
      fireEvent.click(button);
    }
    expect(api.submitDecision).not.toHaveBeenCalled();
  });

  it('retries the selected unavailable Case without reviewing the previous one', async () => {
    vi.mocked(api.getCase).mockImplementation(id => id === caseA.id
      ? Promise.resolve(caseA) : Promise.reject(new Error('Synthetic B detail failure')));
    render(<App />); await screen.findByRole('heading', { name: caseA.raw_name });
    select(caseB.case_number); await screen.findByRole('heading', { name: 'Case details unavailable' });
    vi.mocked(api.getCase).mockResolvedValue(caseB);
    const reads = vi.mocked(api.getCase).mock.calls.length;
    const queueReads = vi.mocked(api.getCases).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry selected case' }));
    await screen.findByRole('heading', { name: caseB.raw_name });
    expect(api.getCase).toHaveBeenCalledTimes(reads + 1);
    expect(api.getCase).toHaveBeenLastCalledWith(caseB.id);
    expect(api.getCases).toHaveBeenCalledTimes(queueReads);
    expect(api.submitDecision).not.toHaveBeenCalled();
  });

  it('keeps actions unavailable while B detail is loading', async () => {
    const slowB = deferred<CaseDetail>();
    vi.mocked(api.getCase).mockImplementation(id => id === caseA.id ? Promise.resolve(caseA) : slowB.promise);
    render(<App />);
    await screen.findByRole('heading', { name: caseA.raw_name });
    select(caseB.case_number);
    expect(screen.getByText('Loading case details...')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Reject All/ })).toBeNull();
    expect(api.submitDecision).not.toHaveBeenCalled();
    await act(async () => slowB.resolve(caseB));
    expect(heading(caseB)).toBeTruthy();
    expect(rejectButton().hasAttribute('disabled')).toBe(false);
  });

  it('ignores a stale detail error after B has rendered', async () => {
    const slowA = deferred<CaseDetail>();
    vi.mocked(api.getCase).mockImplementation(id => id === caseA.id ? slowA.promise : Promise.resolve(caseB));
    render(<App />);
    await waitFor(() => expect(api.getCase).toHaveBeenCalledWith(caseA.id));
    select(caseB.case_number);
    await screen.findByRole('heading', { name: caseB.raw_name });
    await act(async () => slowA.reject(new Error('Synthetic stale A failure')));
    expect(heading(caseB)).toBeTruthy();
    expect(screen.queryByText('Could not load case detail.')).toBeNull();
    expect(rejectButton().hasAttribute('disabled')).toBe(false);
  });

  it('rejects detail returned for the wrong requested identity', async () => {
    vi.mocked(api.getCase).mockResolvedValue(caseA);
    render(<App />);
    await screen.findByRole('heading', { name: caseA.raw_name });
    select(caseB.case_number);
    await waitFor(() => expect(api.getCase).toHaveBeenCalledWith(caseB.id));
    await waitFor(() => expect(rejectButton().hasAttribute('disabled')).toBe(true));
    fireEvent.click(rejectButton());
    expect(api.submitDecision).not.toHaveBeenCalled();
  });

  it('does not replace B or jump back when an in-flight A review finishes', async () => {
    const reviewA = deferred<CaseDetail>();
    vi.mocked(api.submitDecision).mockReturnValue(reviewA.promise);
    render(<App />);
    await screen.findByRole('heading', { name: caseA.raw_name });
    fireEvent.click(rejectButton());
    expect(api.submitDecision).toHaveBeenCalledWith(caseA.id, expect.objectContaining({ decision: 'REJECTED' }));
    select(caseB.case_number);
    await screen.findByRole('heading', { name: caseB.raw_name });
    expect(rejectButton().hasAttribute('disabled')).toBe(true);
    await act(async () => reviewA.resolve({ ...caseA, review_decision: 'REJECTED' }));
    expect(heading(caseB)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Recommendation and human decision' })).getByText('Not reviewed')).toBeTruthy();
    expect(api.getCases).toHaveBeenCalledTimes(1);
    expect(api.submitDecision).toHaveBeenCalledTimes(1);
    expect(rejectButton().hasAttribute('disabled')).toBe(false);
    select(caseA.case_number);
    expect(screen.getByRole('button', { name: new RegExp(caseA.case_number) }).textContent).toContain('Rejected');
  });

  it('ignores an A review response after switching A to B to A again', async () => {
    const reviewA = deferred<CaseDetail>();
    vi.mocked(api.submitDecision).mockReturnValue(reviewA.promise);
    render(<App />);
    await screen.findByRole('heading', { name: caseA.raw_name });
    fireEvent.click(rejectButton());
    select(caseB.case_number);
    await screen.findByRole('heading', { name: caseB.raw_name });
    select(caseA.case_number);
    await screen.findByRole('heading', { name: caseA.raw_name });
    await act(async () => reviewA.resolve({ ...caseA, review_decision: 'REJECTED', raw_name: 'Obsolete A response' }));
    expect(heading(caseA)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Obsolete A response' })).toBeNull();
  });

  it('discards review queue refresh that completes after selection changes', async () => {
    const refresh = deferred<typeof summaries>();
    vi.mocked(api.getCases).mockResolvedValueOnce(summaries).mockReturnValueOnce(refresh.promise);
    render(<App />);
    await screen.findByRole('heading', { name: caseA.raw_name });
    fireEvent.click(rejectButton());
    await screen.findByText('Current Verdict: REJECTED');
    await waitFor(() => expect(api.getCases).toHaveBeenCalledTimes(2));
    vi.mocked(api.getCases).mockResolvedValueOnce([summaries[1]]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search cases' }), { target: { value: caseB.raw_name } });
    await screen.findByRole('heading', { name: caseB.raw_name });
    await act(async () => refresh.resolve([sampleSummary]));
    expect(heading(caseB)).toBeTruthy();
    expect(screen.getByRole('button', { name: new RegExp(caseB.case_number) })).toBeTruthy();
  });

  it('keeps the reviewed case selected if refreshed filters exclude it', async () => {
    vi.mocked(api.getCases).mockResolvedValueOnce(summaries).mockResolvedValueOnce([summaries[1]]);
    render(<App />);
    await screen.findByRole('heading', { name: caseA.raw_name });
    fireEvent.click(rejectButton());
    await screen.findByText('Current Verdict: REJECTED');
    await waitFor(() => expect(rejectButton().hasAttribute('disabled')).toBe(false));
    expect(heading(caseA)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: caseB.raw_name })).toBeNull();
  });

  it('never applies a review response that identifies a different case', async () => {
    vi.mocked(api.submitDecision).mockResolvedValue({ ...caseB, review_decision: 'REJECTED' });
    render(<App />);
    await screen.findByRole('heading', { name: caseA.raw_name });
    fireEvent.click(rejectButton());
    await screen.findByText(/Could not confirm the review decision/);
    expect(heading(caseA)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Recommendation and human decision' })).getByText('Not reviewed')).toBeTruthy();
    expect(api.submitDecision).toHaveBeenCalledTimes(1);
  });

  it.each(['ACCEPTED', 'REJECTED', 'NEED_MORE_EVIDENCE'] as ReviewDecision[])('preserves normal %s review and current-case refresh', async decision => {
    render(<App />);
    await screen.findByRole('heading', { name: caseA.raw_name });
    await waitFor(() => expect(screen.getByRole('button', { name: /Candidate A/ }).textContent).toContain('Active'));
    fireEvent.change(screen.getByLabelText('Reviewer Operational Note (Optional)'), { target: { value: 'Synthetic review note' } });
    const name = decision === 'ACCEPTED' ? /Accept Candidate/ : decision === 'REJECTED' ? /Reject All/ : /Need More Evidence/;
    fireEvent.click(screen.getByRole('button', { name }));
    await screen.findByText(`Current Verdict: ${decision}${decision === 'ACCEPTED' ? ' (Candidate Accepted)' : ''}`);
    expect(api.submitDecision).toHaveBeenCalledWith(caseA.id, {
      decision, selected_candidate_id: decision === 'ACCEPTED' ? 'candidate-1' : null, notes: 'Synthetic review note',
    });
    await waitFor(() => expect(api.getCases).toHaveBeenCalledTimes(2));
    expect(heading(caseA)).toBeTruthy();
  });
});
