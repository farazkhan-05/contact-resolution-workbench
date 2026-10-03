import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AIProvenanceSection } from './AIProvenanceSection';
import { api } from '../../api/client';
import { OriginalRecord } from './OriginalRecord';
import { EvidenceMatrix } from './EvidenceMatrix';
import { sampleDetail } from '../../test-support/cases';
import type { AIProvenance, SourceContext } from '../../types';

const auth = vi.hoisted(() => ({ status: 'ready', workspace: { id: 'workspace-a' } }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => auth }));
vi.mock('../../api/client', () => ({ api: { getSourceContext: vi.fn() } }));
const provenance: AIProvenance = { source_type: 'AI_EXTRACTED', job_title: 'Operations Manager', source_context_available: true, unverified: true };
const source = (text: string): SourceContext => ({ source_type: 'AI_EXTRACTED', original_text: text, job_title: 'Operations Manager', created_at: '2026-10-04', unverified: true });
function openNote() {
  const details = screen.getByText('Show source note').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  return details;
}
beforeEach(() => { vi.resetAllMocks(); auth.status = 'ready'; auth.workspace = { id: 'workspace-a' }; });
afterEach(cleanup);

it('labels subject and scoring evidence unverified, displays role only as context, and discloses exact qualifiers as escaped text', async () => {
  const text = 'Her email appears to be leyla@demo.example. She may now work at Demo Labs. She might be in İzmir, but Ankara is also mentioned. <script>synthetic</script>';
  vi.mocked(api.getSourceContext).mockResolvedValue(source(text));
  const { container } = render(<><AIProvenanceSection caseId="a" provenance={provenance} />
    <OriginalRecord caseDetail={{ ...sampleDetail, ai_provenance: provenance }} />
    <EvidenceMatrix activeCandidate={sampleDetail.candidates[0]} aiExtracted /></>);
  expect(screen.getAllByText(/Unverified/).length).toBe(3);
  expect(screen.getByText('Role: Operations Manager')).toBeTruthy();
  expect(screen.getByText(/not used in the match score/)).toBeTruthy();
  expect(api.getSourceContext).not.toHaveBeenCalled();
  const summary = screen.getByText('Show source note');
  expect(summary.tagName).toBe('SUMMARY');
  expect(summary.parentElement?.tagName).toBe('DETAILS');
  openNote();
  await waitFor(() => expect(screen.getByText(text)).toBeTruthy());
  expect(container.querySelector('script')).toBeNull();
});

it('manual evidence has no AI label and historical provenance is unavailable', () => {
  render(<><OriginalRecord caseDetail={sampleDetail} /><AIProvenanceSection caseId="old" provenance={{ ...provenance, job_title: null, source_context_available: false }} /></>);
  expect(screen.getAllByText(/Unverified/).length).toBe(1);
  expect(screen.getByText('Source context unavailable.')).toBeTruthy();
  expect(screen.queryByText('Show source note')).toBeNull();
  expect(api.getSourceContext).not.toHaveBeenCalled();
});

it('discards slow Case A after switching to B, and restores provenance after reload', async () => {
  let resolveA!: (value: SourceContext) => void;
  vi.mocked(api.getSourceContext).mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; }))
    .mockResolvedValue(source('B qualifier: possibly'));
  const view = render(<AIProvenanceSection caseId="a" provenance={provenance} />);
  openNote();
  await waitFor(() => expect(api.getSourceContext).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(api.getSourceContext).mock.calls[0][1];
  view.rerender(<AIProvenanceSection caseId="b" provenance={provenance} />);
  expect(signal?.aborted).toBe(true);
  openNote();
  await waitFor(() => expect(screen.getByText('B qualifier: possibly')).toBeTruthy());
  await act(async () => resolveA(source('A private note')));
  expect(screen.queryByText('A private note')).toBeNull();
  view.unmount();
  render(<AIProvenanceSection caseId="b" provenance={provenance} />);
  expect(screen.queryByText('B qualifier: possibly')).toBeNull();
  openNote();
  await waitFor(() => expect(screen.getByText('B qualifier: possibly')).toBeTruthy());
});

it.each(['workspace', 'session', 'unmount'])('discards requests on %s change', async (change) => {
  let resolve!: (value: SourceContext) => void;
  vi.mocked(api.getSourceContext).mockImplementation(() => new Promise(done => { resolve = done; }));
  const view = render(<AIProvenanceSection caseId="a" provenance={provenance} />);
  openNote();
  await waitFor(() => expect(api.getSourceContext).toHaveBeenCalledTimes(1));
  if (change === 'workspace') auth.workspace = { id: 'workspace-b' };
  if (change === 'session') auth.status = 'signed_out';
  if (change === 'unmount') view.unmount();
  else view.rerender(<AIProvenanceSection caseId="a" provenance={provenance} />);
  expect(vi.mocked(api.getSourceContext).mock.calls[0][1]?.aborted).toBe(true);
  await act(async () => resolve(source('Old session text')));
  expect(screen.queryByText('Old session text')).toBeNull();
});

it('shows a safe failure message without echoing internal details', async () => {
  vi.mocked(api.getSourceContext).mockRejectedValue(new Error('synthetic internal payload'));
  render(<AIProvenanceSection caseId="a" provenance={provenance} />);
  openNote();
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Source context unavailable.'));
  expect(screen.queryByText('synthetic internal payload')).toBeNull();
});
