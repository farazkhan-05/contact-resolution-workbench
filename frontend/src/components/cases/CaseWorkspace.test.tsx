import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CaseDetail } from './CaseDetail';
import { CaseQueue } from './CaseQueue';
import { EvidenceMatrix } from './EvidenceMatrix';
import { ContradictionAlert } from './ContradictionAlert';
import { emptyCandidateDetail, summaryFor, workspaceDetail } from '../../test-support/case-workspace';

// Operational panels have their own maintained lifecycle and authorization tests.
vi.mock('./InvestigationPanel', () => ({ InvestigationPanel: () => <div>Investigation entry point</div> }));
afterEach(cleanup);
const detailProps = () => ({ caseDetail: workspaceDetail, selectedCaseId: workspaceDetail.id,
  isLoading: false, onBackMobile: vi.fn(), onSubmitDecision: vi.fn(async () => {}),
  isSubmittingDecision: false, isReviewReady: true, onRefresh: vi.fn() });
const queueProps = () => ({ cases: [summaryFor(workspaceDetail)], selectedCaseId: workspaceDetail.id,
  onSelectCase: vi.fn(), activeRoutingFilter: 'ALL' as const, onRoutingFilterChange: vi.fn(),
  activeDecisionFilter: 'ALL' as const, onDecisionFilterChange: vi.fn(),
  searchQuery: '', onSearchChange: vi.fn(), isLoading: false, showFilters: true });

it('separates system recommendation from an actual accepted human decision', () => {
  render(<CaseDetail {...detailProps()} caseDetail={{ ...workspaceDetail, review_decision: 'ACCEPTED' }} />);
  const decisions = within(screen.getByRole('region', { name: 'Recommendation and human decision' }));
  expect(decisions.getByRole('heading', { name: 'System recommendation' })).toBeTruthy();
  expect(decisions.getByText('Likely match')).toBeTruthy();
  expect(decisions.getByRole('heading', { name: 'Human decision' })).toBeTruthy();
  expect(decisions.getByText('Accepted')).toBeTruthy();
});
it('shows only available source metadata and the actual incoming fields', () => {
  render(<CaseDetail {...detailProps()} />);
  expect(screen.getByText('Source type: CSV UPLOAD')).toBeTruthy();
  expect(screen.getByText(/^Received:/)).toBeTruthy();
  expect(screen.queryByText(/^Created:/)).toBeNull();
  expect(screen.getByText('synthetic-source')).toBeTruthy();
  expect(screen.getByText('synthetic-import')).toBeTruthy();
  const original = within(screen.getByRole('region', { name: 'Original ingested record' }));
  expect(original.getByText('Claire Reynolds Jr.')).toBeTruthy();
  expect(original.getByText('Not provided')).toBeTruthy();
  expect(screen.queryByText(/Unverified/)).toBeNull();
});
it('uses created date when received date is absent without inventing provenance', () => {
  render(<CaseDetail {...detailProps()} caseDetail={{ ...workspaceDetail, received_at: null, source_id: null, ingestion_id: null, external_record_id: null, ingestion_mechanism: undefined }} />);
  expect(screen.getByText(/^Created:/)).toBeTruthy();
  expect(screen.queryByText(/^Received:/)).toBeNull();
  expect(screen.queryByText('Source details')).toBeNull();
  expect(screen.queryByText(/^Source type:/)).toBeNull();
});
it('replaces evidence, provenance, conflicts, score and review candidate together', () => {
  const props = detailProps(); render(<CaseDetail {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /Candidate B/ }));
  expect(screen.getByText('Record: alumni-002')).toBeTruthy();
  expect(screen.getByText('Base name matches with suffix variation.')).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Selected candidate conflicts' })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Candidate B/ }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: /Accept Candidate/ }).hasAttribute('disabled')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: /Accept Candidate/ }));
  expect(props.onSubmitDecision).toHaveBeenCalledExactlyOnceWith(workspaceDetail.id, 'ACCEPTED', 'candidate-alternate', '');
  fireEvent.click(screen.getByRole('button', { name: /Candidate A/ }));
  expect(screen.queryByText('Record: alumni-002')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Selected candidate conflicts' })).toBeNull();
  expect(screen.queryByText('Base name matches with suffix variation.')).toBeNull();
});
it('resets candidate selection synchronously when Cases reuse candidate identifiers', () => {
  const props = detailProps(); const view = render(<CaseDetail {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /Candidate B/ }));
  const next = { ...workspaceDetail, id: 'next-case', raw_name: 'Different incoming record' };
  view.rerender(<CaseDetail {...props} caseDetail={next} selectedCaseId={next.id} />);
  expect(screen.getByRole('button', { name: /Candidate A/ }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('region', { name: 'Selected candidate conflicts' })).toBeNull();
});
it('hides mismatched Case evidence, disables decisions and retains retry and queue access', () => {
  const props = detailProps(); render(<CaseDetail {...props} selectedCaseId="failed-case" />);
  expect(screen.getByRole('heading', { name: 'Case details unavailable' })).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
  for (const label of ['Accept Candidate', 'Reject All', 'Need More Evidence']) expect(screen.getByRole('button', { name: label }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry selected case' }));
  fireEvent.click(screen.getByRole('button', { name: 'Back to case queue' }));
  expect(props.onRefresh).toHaveBeenCalledTimes(1); expect(props.onBackMobile).toHaveBeenCalledTimes(1);
});
it('announces loading and provides a way back before data is ready', () => {
  const props = detailProps(); render(<CaseDetail {...props} isLoading />);
  expect(screen.getByRole('status').textContent).toBe('Loading case details...');
  expect(screen.queryByRole('table')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Back to case queue' }));
  expect(props.onBackMobile).toHaveBeenCalledTimes(1);
});
it('handles missing fields and zero candidates while preserving reject and evidence actions', () => {
  render(<CaseDetail {...detailProps()} caseDetail={emptyCandidateDetail} selectedCaseId={emptyCandidateDetail.id} />);
  expect(screen.getByText('0 candidates')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'No matching candidates found' })).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.getByRole('button', { name: /Accept Candidate/ }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Reject All' }).hasAttribute('disabled')).toBe(false);
  expect(screen.getByRole('button', { name: 'Need More Evidence' }).hasAttribute('disabled')).toBe(false);
  expect(within(screen.getByRole('region', { name: 'Original ingested record' })).getAllByText('Not provided')).toHaveLength(4);
});
it('displays server field maximums and match method rather than inferring scoring', () => {
  render(<EvidenceMatrix activeCandidate={workspaceDetail.candidates[0]} />);
  const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
  expect(rows.map(row => row.textContent?.match(/\/ (\d+)$/)?.[1])).toEqual(['30', '25', '25', '10', '10']);
  expect(screen.getByText('Missing field')).toBeTruthy();
  expect(screen.getByText(/not identity probabilities/)).toBeTruthy();
});
it('explains unavailable evidence and a serious flag without inventing a conflict description', () => {
  render(<><EvidenceMatrix activeCandidate={{ ...workspaceDetail.candidates[0], evidence: [] }} /><ContradictionAlert contradictions={[]} seriousFlag /></>);
  expect(screen.getByText('Field evidence is unavailable for this candidate.')).toBeTruthy();
  expect(screen.getByText('Serious conflict reported for this candidate')).toBeTruthy();
  expect(screen.getByText('The conflict explanation is not available. Review the evidence before deciding.')).toBeTruthy();
});
it('labels counts as displayed results and retains exact filter values and selected semantics', () => {
  const props = queueProps(); render(<CaseQueue {...props} activeRoutingFilter="NEEDS_REVIEW" />);
  expect(screen.getByText('1 results shown')).toBeTruthy();
  const row = screen.getByRole('button', { name: /SAMPLE-001/ });
  expect(row.getAttribute('aria-current')).toBe('true'); fireEvent.click(row);
  expect(props.onSelectCase).toHaveBeenCalledWith(workspaceDetail.id);
  fireEvent.change(screen.getByLabelText('Recommendation'), { target: { value: 'NO_RELIABLE_MATCH' } });
  fireEvent.change(screen.getByLabelText('Decision filter'), { target: { value: 'NEED_MORE_EVIDENCE' } });
  expect(props.onRoutingFilterChange).toHaveBeenCalledWith('NO_RELIABLE_MATCH');
  expect(props.onDecisionFilterChange).toHaveBeenCalledWith('NEED_MORE_EVIDENCE');
});
it('distinguishes loading queue from an empty filtered result', () => {
  const props = queueProps(); const view = render(<CaseQueue {...props} cases={[]} isLoading />);
  expect(screen.getByText('Loading cases...').getAttribute('role')).toBe('status');
  view.rerender(<CaseQueue {...props} cases={[]} searchQuery="missing" />);
  expect(screen.getByText('0 results shown')).toBeTruthy();
  expect(screen.getByText('No cases match your filters')).toBeTruthy();
});
