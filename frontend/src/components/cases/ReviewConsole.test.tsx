import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ReviewConsole } from './ReviewConsole';
import { workspaceDetail, emptyCandidateDetail } from '../../test-support/case-workspace';
import { decisionLabel } from './casePresentation';

afterEach(cleanup);
const props = () => ({ caseDetail: workspaceDetail, activeCandidate: workspaceDetail.candidates[0],
  onSubmitDecision: vi.fn(async () => {}), isSubmitting: false, isReviewReady: true,
  onViewEvidence: vi.fn(), onChangeCandidate: vi.fn(), onViewHistory: vi.fn(), onCheckSavedDecision: vi.fn() });
const review = () => within(screen.getByRole('region', { name: 'Your review' }));
const accept = () => review().getByRole('button', { name: /Accept Candidate/ });

it('names the actual Case, selected candidate and evidence entry point without deciding automatically', () => {
  const value = props(); render(<ReviewConsole {...value} />);
  expect(review().getByText(/SAMPLE-001 · Claire Reynolds Jr./)).toBeTruthy();
  expect(review().getByText('Claire Reynolds Jr.', { exact: true })).toBeTruthy();
  expect(review().getByText('5 evidence fields · Evidence score: 75 / 100')).toBeTruthy();
  expect(review().getByText('Not reviewed')).toBeTruthy();
  fireEvent.click(review().getByRole('button', { name: 'Review field evidence' }));
  fireEvent.click(review().getByRole('button', { name: 'Change candidate' }));
  fireEvent.click(review().getByRole('button', { name: /View Case history/ }));
  expect(value.onViewEvidence).toHaveBeenCalledTimes(1); expect(value.onChangeCandidate).toHaveBeenCalledTimes(1);
  expect(value.onViewHistory).toHaveBeenCalledTimes(1); expect(value.onSubmitDecision).not.toHaveBeenCalled();
});
it('keeps Accept enabled and secondary while making Need More Evidence primary for a serious conflict', () => {
  render(<ReviewConsole {...props()} activeCandidate={workspaceDetail.candidates[1]} />);
  expect(accept().className).toContain('ui-button-secondary'); expect(accept().hasAttribute('disabled')).toBe(false);
  expect(review().getByRole('button', { name: 'Need More Evidence' }).className).toContain('ui-button-primary');
  expect(review().getByRole('note').textContent).toContain(workspaceDetail.candidates[1].contradictions[0].description);
  expect(accept().getAttribute('aria-describedby')).toBe('review-conflict-reminder');
  expect(review().queryByRole('alert')).toBeNull();
});
it('uses balanced secondary actions when no serious conflict is reported', () => {
  render(<ReviewConsole {...props()} />);
  for (const label of [/Accept Candidate/, /Reject All/, /Need More Evidence/]) expect(review().getByRole('button', { name: label }).className).toContain('ui-button-secondary');
  expect(review().queryByRole('note')).toBeNull();
});
it('retains the draft note across candidate changes and binds acceptance to the new candidate', async () => {
  const value = props(); const view = render(<ReviewConsole {...value} />);
  fireEvent.change(screen.getByLabelText('Reviewer note (optional)'), { target: { value: '  Synthetic evidence note  ' } });
  view.rerender(<ReviewConsole {...value} activeCandidate={workspaceDetail.candidates[1]} />);
  expect((screen.getByLabelText('Reviewer note (optional)') as HTMLTextAreaElement).value).toBe('  Synthetic evidence note  ');
  await act(async () => fireEvent.click(accept()));
  expect(value.onSubmitDecision).toHaveBeenCalledExactlyOnceWith(workspaceDetail.id, 'ACCEPTED', 'candidate-alternate', '  Synthetic evidence note  ');
  // A resolved callback alone cannot change the saved human decision.
  expect(review().getByText('Not reviewed')).toBeTruthy();
});
it.each(['REJECTED', 'NEED_MORE_EVIDENCE'] as const)('submits %s with no accepted candidate and an optional empty note', async decision => {
  const value = props(); render(<ReviewConsole {...value} />);
  await act(async () => fireEvent.click(review().getByRole('button', { name: decision === 'REJECTED' ? 'Reject All' : 'Need More Evidence' })));
  expect(value.onSubmitDecision).toHaveBeenCalledExactlyOnceWith(workspaceDetail.id, decision, null, '');
});
it('restores the saved note and decision from authoritative readback independently of selected candidate', () => {
  const value = props(); const view = render(<ReviewConsole {...value} />);
  fireEvent.change(screen.getByLabelText('Reviewer note (optional)'), { target: { value: 'Unsaved draft' } });
  view.rerender(<ReviewConsole {...value} caseDetail={{ ...workspaceDetail, review_decision: 'ACCEPTED',
    selected_candidate_id: workspaceDetail.candidates[0].id, reviewer_notes: 'Saved server note', reviewed_at: workspaceDetail.created_at }}
    activeCandidate={workspaceDetail.candidates[1]} />);
  expect(review().getByText(decisionLabel.ACCEPTED)).toBeTruthy();
  expect(review().getByText('Saved candidate: Claire Reynolds Jr.')).toBeTruthy();
  expect(review().getByText('Claire Reynolds Sr.', { exact: true })).toBeTruthy();
  expect((screen.getByLabelText('Reviewer note (optional)') as HTMLTextAreaElement).value).toBe('Saved server note');
  expect(value.onSubmitDecision).not.toHaveBeenCalled();
});
it('associates the optional note and character limit without adding validation conditions', () => {
  render(<ReviewConsole {...props()} />);
  const notes = screen.getByLabelText('Reviewer note (optional)');
  expect(notes.getAttribute('maxlength')).toBe('2000'); expect(notes.hasAttribute('required')).toBe(false);
  const references = notes.getAttribute('aria-describedby')!.split(' ');
  expect(references.every(id => document.getElementById(id))).toBe(true);
  expect(references.map(id => document.getElementById(id)!.textContent).join(' ')).toContain('Optional; up to 2,000 characters.');
  expect(review().queryByRole('alert')).toBeNull();
});
it('provides a disabled explanation and only read recovery for an uncertain write', () => {
  const value = props(); render(<ReviewConsole {...value} isReviewReady={false} readbackRequired />);
  for (const label of [/Accept Candidate/, /Reject All/, /Need More Evidence/]) {
    const button = review().getByRole('button', { name: label });
    expect(button.hasAttribute('disabled')).toBe(true); expect(button.getAttribute('aria-describedby')).toBe('review-unavailable');
    fireEvent.click(button);
  }
  fireEvent.click(review().getByRole('button', { name: 'Check saved decision' }));
  expect(value.onCheckSavedDecision).toHaveBeenCalledTimes(1); expect(value.onSubmitDecision).not.toHaveBeenCalled();
  expect(review().getByText(/saved decision is unconfirmed/)).toBeTruthy();
  expect(review().getByText('Last loaded decision')).toBeTruthy();
});
it('prevents repeated submission and keeps the in-flight candidate context when selection changes', async () => {
  let finish!: () => void; const value = props(); value.onSubmitDecision.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const view = render(<ReviewConsole {...value} />); fireEvent.click(accept()); fireEvent.click(accept());
  view.rerender(<ReviewConsole {...value} activeCandidate={workspaceDetail.candidates[1]} isSubmitting />);
  expect(value.onSubmitDecision).toHaveBeenCalledTimes(1);
  expect(review().getByRole('status').textContent).toContain('Accept Candidate · SAMPLE-001 · Claire Reynolds Jr.');
  expect(review().getByText('Claire Reynolds Sr.', { exact: true })).toBeTruthy();
  for (const label of [/Accept Candidate/, /Reject All/, /Need More Evidence/]) expect(review().getByRole('button', { name: label }).hasAttribute('disabled')).toBe(true);
  await act(async () => finish());
});
it('does not attribute a different Case submission to the currently displayed Case', () => {
  render(<ReviewConsole {...props()} isSubmitting />);
  expect(review().getByRole('status').textContent).toBe('A review request is in progress. Wait for it to finish before submitting.');
  expect(review().getByText('Not reviewed')).toBeTruthy();
});
it('fails closed for a candidate that does not belong to the displayed Case', () => {
  const value = props(); render(<ReviewConsole {...value} activeCandidate={{ ...workspaceDetail.candidates[0], id: 'foreign-candidate' }} />);
  expect(accept().hasAttribute('disabled')).toBe(true);
  expect(accept().getAttribute('aria-describedby')).toBe('review-no-candidate'); fireEvent.click(accept());
  expect(value.onSubmitDecision).not.toHaveBeenCalled();
});
it('keeps Reject and Need More Evidence available when no candidates exist', () => {
  render(<ReviewConsole {...props()} caseDetail={emptyCandidateDetail} activeCandidate={null} />);
  expect(accept().hasAttribute('disabled')).toBe(true);
  expect(review().getByRole('button', { name: 'Reject All' }).hasAttribute('disabled')).toBe(false);
  expect(review().getByRole('button', { name: 'Need More Evidence' }).hasAttribute('disabled')).toBe(false);
});
