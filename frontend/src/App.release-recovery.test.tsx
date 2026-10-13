import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { api, ApiError } from './api/client';
import { recordUsageEvent } from './api/telemetry';
import { sampleDetail, sampleSummary } from './test-support/cases';
import { syntheticJob } from './test-support/jobs';

const auth = vi.hoisted(() => ({
  status: 'ready', operation: null as string | null,
  workspace: { id: 'test-workspace', role: 'OWNER' } as { id: string; role: string } | null,
  signOutUser: vi.fn(async () => {}),
}));
vi.mock('./auth/AuthProvider', () => ({ useAuth: () => auth }));
vi.mock('./api/telemetry', () => ({ recordUsageEvent: vi.fn() }));
vi.mock('./api/client', async original => {
  const actual = await original<typeof import('./api/client')>();
  return { ...actual, api: Object.fromEntries(Object.keys(actual.api).map(key => [key, vi.fn()])) };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const reviewed = { ...sampleSummary, review_decision: 'REJECTED' as const };
const sampleResult = { ingested_count: 1, created_count: 1, existing_count: 0, case_ids: [reviewed.id] };
const csvFile = (name = 'synthetic.csv') => new File(['case_number,full_name\nSYN-1,Synthetic Person'], name, { type: 'text/csv' });
const selectFile = (file = csvFile()) => fireEvent.change(screen.getByLabelText('Upload CSV file'), { target: { files: [file] } });
async function mount() {
  const view = render(<App />);
  await screen.findByRole('heading', { name: sampleDetail.raw_name });
  return view;
}
function transition(view: ReturnType<typeof render>, kind: string) {
  if (kind === 'sign-out pending') auth.operation = 'sign_out';
  else if (kind === 'signed out' || kind === 'same workspace new session') { auth.status = 'signed_out'; auth.workspace = null; }
  else auth.workspace = { id: 'other-workspace', role: 'OWNER' };
  view.rerender(<App />);
  if (kind === 'workspace round trip' || kind === 'same workspace new session') {
    auth.status = 'ready'; auth.operation = null; auth.workspace = { id: 'test-workspace', role: 'OWNER' };
    view.rerender(<App />);
  }
}

beforeEach(() => {
  sessionStorage.clear();
  auth.status = 'ready'; auth.operation = null; auth.workspace = { id: 'test-workspace', role: 'OWNER' };
  vi.mocked(api.getCases).mockResolvedValue([reviewed]);
  vi.mocked(api.getCase).mockResolvedValue({ ...sampleDetail, review_decision: 'REJECTED' });
  vi.mocked(api.listInvestigations).mockResolvedValue([]);
  vi.mocked(api.listJobs).mockResolvedValue([]);
  vi.mocked(api.ingestSample).mockResolvedValue(sampleResult);
  vi.mocked(api.ingestCsv).mockResolvedValue(syntheticJob({ job_type: 'CSV_INGEST' }));
  vi.mocked(api.getJob).mockResolvedValue(syntheticJob({ job_type: 'CSV_INGEST', status: 'SUCCEEDED', successful_rows: 1 }));
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:synthetic-export') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); vi.resetAllMocks(); });

describe('export and sample session ownership', () => {
  for (const kind of ['sign-out pending', 'signed out', 'workspace change', 'workspace round trip', 'same workspace new session']) {
    it.each(['success', 'failure'])('discards late export %s after ' + kind, async outcome => {
      const pending = deferred<Blob>(); vi.mocked(api.exportReviewedCsv).mockReturnValueOnce(pending.promise);
      const view = await mount(); fireEvent.click(screen.getByRole('button', { name: 'Export Reviewed' }));
      transition(view, kind);
      await act(async () => { if (outcome === 'success') pending.resolve(new Blob(['synthetic'])); else pending.reject(Error('Old export failure')); });
      expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
      expect(recordUsageEvent).not.toHaveBeenCalledWith('CSV_EXPORTED');
      expect(screen.queryByText('Downloaded reviewed cases CSV.')).toBeNull();
      expect(screen.queryByText('Failed to export reviewed cases.')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Try export again' })).toBeNull();
    });
  }
  it('exports normally and offers a current-session read retry after failure', async () => {
    vi.mocked(api.exportReviewedCsv).mockRejectedValueOnce(new ApiError(503, 'Synthetic export unavailable')).mockResolvedValueOnce(new Blob(['synthetic']));
    await mount(); fireEvent.click(screen.getByRole('button', { name: 'Export Reviewed' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Try export again' }));
    await screen.findByText('Downloaded reviewed cases CSV.');
    expect(api.exportReviewedCsv).toHaveBeenCalledTimes(2); expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-export');
  });
  it('an old export cannot clear a newer workspace export loading state', async () => {
    const old = deferred<Blob>(); const next = deferred<Blob>();
    vi.mocked(api.exportReviewedCsv).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const view = await mount(); fireEvent.click(screen.getByRole('button', { name: 'Export Reviewed' }));
    transition(view, 'workspace change');
    fireEvent.click(screen.getByRole('button', { name: 'Export Reviewed' }));
    await act(async () => old.resolve(new Blob(['old'])));
    expect(screen.getByRole('button', { name: 'Export Reviewed' }).hasAttribute('disabled')).toBe(true);
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
    await act(async () => next.resolve(new Blob(['current'])));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
  });
  it('does not download after unmount', async () => {
    const pending = deferred<Blob>(); vi.mocked(api.exportReviewedCsv).mockReturnValueOnce(pending.promise);
    const view = await mount(); fireEvent.click(screen.getByRole('button', { name: 'Export Reviewed' })); view.unmount();
    await act(async () => pending.resolve(new Blob(['synthetic'])));
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });
  for (const kind of ['sign-out pending', 'signed out', 'workspace change']) {
    it.each(['success', 'failure'])('discards late sample %s after ' + kind, async outcome => {
      const pending = deferred<typeof sampleResult>(); vi.mocked(api.ingestSample).mockReturnValueOnce(pending.promise);
      const view = await mount(); fireEvent.click(screen.getByRole('button', { name: 'Load Sample Cases' }));
      transition(view, kind); const reads = vi.mocked(api.getCases).mock.calls.length;
      await act(async () => { if (outcome === 'success') pending.resolve(sampleResult); else pending.reject(Error('Old sample failure')); });
      expect(api.getCases).toHaveBeenCalledTimes(reads);
      expect(recordUsageEvent).not.toHaveBeenCalledWith('SAMPLE_CASES_LOADED');
      expect(screen.queryByText('1 sample cases available. 1 created.')).toBeNull();
      expect(screen.queryByText('Failed to load sample cases.')).toBeNull();
    });
  }
  it('sample completion uses the current filter fetcher and preserves normal refresh', async () => {
    const pending = deferred<typeof sampleResult>(); vi.mocked(api.ingestSample).mockReturnValueOnce(pending.promise);
    await mount(); fireEvent.click(screen.getByRole('button', { name: 'Load Sample Cases' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search cases' }), { target: { value: 'Synthetic' } });
    await act(async () => pending.resolve(sampleResult));
    await screen.findByText('1 sample cases available. 1 created.');
    expect(api.getCases).toHaveBeenLastCalledWith({ routing_status: undefined, review_decision: undefined, search: 'Synthetic' });
  });
});

describe('CSV uncertain acknowledgement recovery', () => {
  it.each([400, 401, 403, 413, 422])('retains unknown A through confirmed HTTP %s rejection of informed B and guards C', async status => {
    const pending = deferred<ReturnType<typeof syntheticJob>>();
    vi.mocked(api.ingestCsv).mockRejectedValueOnce(Error('Lost A acknowledgement')).mockReturnValueOnce(pending.promise);
    await mount(); selectFile(csvFile('A.csv'));
    await screen.findByText('CSV submission unconfirmed: A.csv'); selectFile(csvFile('B.csv'));
    expect(api.ingestCsv).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'I understand; submit new upload' }));
    expect(api.ingestCsv).toHaveBeenCalledTimes(2);
    expect(screen.getByText('CSV submission unconfirmed: A.csv')).toBeTruthy();
    await act(async () => pending.reject(new ApiError(status, 'B rejected')));
    await screen.findByText('CSV upload was not accepted. B rejected');
    expect(sessionStorage.getItem('crw.csv-submission-unconfirmed:test-workspace')).toBe('1');
    selectFile(csvFile('C.csv'));
    const dialog = screen.getByRole('dialog', { name: 'Submit another CSV?' });
    expect(dialog.textContent).toContain('A.csv'); expect(dialog.textContent).toContain('C.csv');
    expect(api.ingestCsv).toHaveBeenCalledTimes(2);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check CSV activity' }));
    await screen.findByText('No recent imports.'); expect(api.ingestCsv).toHaveBeenCalledTimes(2);
    selectFile(csvFile('C.csv')); fireEvent.click(screen.getByRole('button', { name: 'I understand; submit new upload' }));
    await screen.findByText('1 record imported.'); expect(api.ingestCsv).toHaveBeenCalledTimes(3);
    expect(screen.getByText('CSV submission unconfirmed: A.csv')).toBeTruthy();
  });
  it.each(['rejected', 'accepted'])('reload preserves unknown A after informed B is %s', async outcome => {
    vi.mocked(api.ingestCsv).mockRejectedValueOnce(Error('Lost A acknowledgement'));
    const view = await mount(); selectFile(csvFile('A.csv'));
    await screen.findByText('CSV submission unconfirmed: A.csv'); selectFile(csvFile('B.csv'));
    if (outcome === 'rejected') vi.mocked(api.ingestCsv).mockRejectedValueOnce(new ApiError(422, 'B rejected'));
    fireEvent.click(screen.getByRole('button', { name: 'I understand; submit new upload' }));
    await screen.findByText(outcome === 'rejected' ? 'CSV upload was not accepted. B rejected' : '1 record imported.');
    expect(sessionStorage.getItem('crw.csv-submission-unconfirmed:test-workspace')).toBe('1');
    view.unmount(); await mount();
    await screen.findByText('CSV submission unconfirmed: previous CSV upload'); selectFile(csvFile('C.csv'));
    expect(screen.getByRole('dialog', { name: 'Submit another CSV?' })).toBeTruthy();
    expect(api.ingestCsv).toHaveBeenCalledTimes(2); expect(api.getJob).toHaveBeenCalledTimes(outcome === 'accepted' ? 1 : 0);
  });
  it.each(['success', 'rejection'])('late informed B %s cannot erase A or affect another workspace', async outcome => {
    const pending = deferred<ReturnType<typeof syntheticJob>>();
    vi.mocked(api.ingestCsv).mockRejectedValueOnce(Error('Lost A acknowledgement')).mockReturnValueOnce(pending.promise);
    const view = await mount(); selectFile(csvFile('A.csv'));
    await screen.findByText('CSV submission unconfirmed: A.csv'); selectFile(csvFile('B.csv'));
    fireEvent.click(screen.getByRole('button', { name: 'I understand; submit new upload' }));
    transition(view, 'workspace change'); expect(screen.queryByText(/CSV submission unconfirmed/)).toBeNull();
    vi.mocked(api.getJob).mockResolvedValueOnce(syntheticJob({ workspace_id: 'other-workspace', job_type: 'CSV_INGEST', status: 'SUCCEEDED', successful_rows: 1 }));
    selectFile(csvFile('other-workspace.csv')); await screen.findByText('1 record imported.');
    expect(api.ingestCsv).toHaveBeenCalledTimes(3); expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => {
      if (outcome === 'success') pending.resolve(syntheticJob({ job_type: 'CSV_INGEST' }));
      else pending.reject(new ApiError(422, 'Old B rejected'));
    });
    expect(screen.queryByText('CSV upload was not accepted. Old B rejected')).toBeNull();
    expect(sessionStorage.getItem('crw.csv-submission-unconfirmed:test-workspace')).toBe('1');
    auth.workspace = { id: 'test-workspace', role: 'OWNER' }; view.rerender(<App />);
    await screen.findByText('CSV submission unconfirmed: previous CSV upload'); selectFile(csvFile('C.csv'));
    expect(screen.getByRole('dialog', { name: 'Submit another CSV?' })).toBeTruthy(); expect(api.ingestCsv).toHaveBeenCalledTimes(3);
  });
  it('a new session in the same workspace retains earlier CSV uncertainty without replaying writes', async () => {
    vi.mocked(api.ingestCsv).mockRejectedValueOnce(Error('Lost A acknowledgement'));
    const view = await mount(); selectFile(csvFile('A.csv')); await screen.findByText('CSV submission unconfirmed: A.csv');
    transition(view, 'same workspace new session'); await screen.findByText('CSV submission unconfirmed: previous CSV upload');
    selectFile(csvFile('B.csv')); expect(screen.getByRole('dialog', { name: 'Submit another CSV?' })).toBeTruthy();
    expect(api.ingestCsv).toHaveBeenCalledTimes(1);
  });
  it.each(['pending', 'unknown'])('restores uncertainty after reload with a %s acknowledgement and persists no file data', async state => {
    const pending = deferred<ReturnType<typeof syntheticJob>>(); vi.mocked(api.ingestCsv).mockReturnValueOnce(pending.promise);
    const view = await mount(); selectFile(csvFile('private-filename.csv'));
    if (state === 'unknown') await act(async () => pending.reject(Error('Lost acknowledgement')));
    expect(sessionStorage.length).toBe(1);
    expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe('1');
    expect(sessionStorage.key(0)).not.toContain('private-filename');
    view.unmount(); await mount();
    await screen.findByText('CSV submission unconfirmed: previous CSV upload'); selectFile();
    expect(screen.getByRole('dialog', { name: 'Submit another CSV?' })).toBeTruthy(); expect(api.ingestCsv).toHaveBeenCalledTimes(1);
    if (state === 'pending') await act(async () => pending.resolve(syntheticJob({ job_type: 'CSV_INGEST' })));
    expect(sessionStorage.length).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'I understand; submit new upload' }));
    await screen.findByText('1 record imported.'); expect(sessionStorage.length).toBe(1);
    expect(screen.getByText('CSV submission unconfirmed: previous CSV upload')).toBeTruthy();
  });
  it('restores an old workspace guard only when returning to that workspace', async () => {
    vi.mocked(api.ingestCsv).mockRejectedValueOnce(Error('Lost acknowledgement'));
    const view = await mount(); selectFile(); await screen.findByText('CSV submission unconfirmed: synthetic.csv');
    transition(view, 'workspace change'); expect(screen.queryByText(/CSV submission unconfirmed/)).toBeNull();
    auth.workspace = { id: 'test-workspace', role: 'OWNER' }; view.rerender(<App />);
    await screen.findByText('CSV submission unconfirmed: previous CSV upload'); selectFile();
    expect(screen.getByRole('dialog', { name: 'Submit another CSV?' })).toBeTruthy(); expect(api.ingestCsv).toHaveBeenCalledTimes(1);
  });
  it('storage failure retains the active-view guard and permits informed recovery', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('Storage unavailable'); });
    vi.mocked(api.ingestCsv).mockRejectedValueOnce(Error('Lost acknowledgement')); await mount(); selectFile();
    await screen.findByText('CSV submission unconfirmed: synthetic.csv'); selectFile();
    expect(api.ingestCsv).toHaveBeenCalledTimes(1); fireEvent.click(screen.getByRole('button', { name: 'I understand; submit new upload' }));
    await screen.findByText('1 record imported.'); expect(api.ingestCsv).toHaveBeenCalledTimes(2);
    selectFile(csvFile('later.csv')); expect(screen.getByRole('dialog', { name: 'Submit another CSV?' })).toBeTruthy();
    expect(api.ingestCsv).toHaveBeenCalledTimes(2);
  });
  it.each([new Error('Lost acknowledgement'), new ApiError(500, 'Synthetic failure'), new ApiError(503, 'Synthetic unavailable')])('blocks repeat submissions after %s', async error => {
    vi.mocked(api.ingestCsv).mockRejectedValueOnce(error); await mount(); selectFile();
    await screen.findByText('CSV submission unconfirmed: synthetic.csv');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }));
    selectFile(); const dialog = screen.getByRole('dialog', { name: 'Submit another CSV?' });
    expect(dialog.textContent).toContain('may duplicate work'); expect(api.ingestCsv).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel new upload' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel new upload' }));
    expect(screen.getByText('CSV submission unconfirmed: synthetic.csv')).toBeTruthy();
    expect(api.ingestCsv).toHaveBeenCalledTimes(1);
  });
  it('activity reads, empty results and history failures cannot unlock or retry the upload', async () => {
    vi.mocked(api.ingestCsv).mockRejectedValueOnce(Error('Lost acknowledgement')); await mount(); selectFile();
    fireEvent.click(await screen.findByRole('button', { name: 'Check CSV activity' }));
    await screen.findByText('No recent imports.');
    expect(screen.getByText(/Missing activity does not prove/)).toBeTruthy();
    vi.mocked(api.listJobs).mockRejectedValueOnce(Error('Unavailable history'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh activity' }));
    await screen.findByText('Recent activity unavailable.'); selectFile();
    expect(screen.getByRole('dialog', { name: 'Submit another CSV?' })).toBeTruthy();
    expect(api.ingestCsv).toHaveBeenCalledTimes(1); expect(api.getJob).not.toHaveBeenCalled();
  });
  it('showing a possible accepted Job does not assert that it reconciles the unknown upload', async () => {
    vi.mocked(api.ingestCsv).mockRejectedValueOnce(Error('Lost acknowledgement')); await mount(); selectFile();
    await screen.findByText('CSV submission unconfirmed: synthetic.csv');
    vi.mocked(api.listJobs).mockResolvedValue([syntheticJob({ job_type: 'CSV_INGEST', status: 'SUCCEEDED' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Check CSV activity' })); await screen.findByText('Completed');
    selectFile(); expect(screen.getByRole('dialog', { name: 'Submit another CSV?' })).toBeTruthy();
    expect(api.ingestCsv).toHaveBeenCalledTimes(1);
  });
  it('requires renewed informed confirmation for subsequent uploads even after a confirmed success', async () => {
    vi.mocked(api.ingestCsv).mockRejectedValueOnce(Error('Lost acknowledgement')); await mount(); selectFile();
    await screen.findByText('CSV submission unconfirmed: synthetic.csv'); const corrected = csvFile('new-records.csv'); selectFile(corrected);
    const dialog = screen.getByRole('dialog', { name: 'Submit another CSV?' });
    expect(dialog.textContent).toContain('new-records.csv');
    expect(dialog.textContent).toContain('does not cancel or retry the previous upload');
    fireEvent.click(within(dialog).getByRole('button', { name: 'I understand; submit new upload' }));
    await screen.findByText('1 record imported.');
    expect(api.ingestCsv).toHaveBeenNthCalledWith(2, corrected); expect(screen.queryByRole('dialog')).toBeNull();
    const later = csvFile('later.csv'); selectFile(later);
    expect(screen.getByRole('dialog', { name: 'Submit another CSV?' })).toBeTruthy();
    expect(api.ingestCsv).toHaveBeenCalledTimes(2);
    expect(screen.getByText('CSV submission unconfirmed: synthetic.csv')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'I understand; submit new upload' }));
    await waitFor(() => expect(api.ingestCsv).toHaveBeenNthCalledWith(3, later));
    expect(screen.getByText('CSV submission unconfirmed: synthetic.csv')).toBeTruthy();
  });
  it.each([400, 401, 403, 413, 422])('permits corrected uploads after confirmed HTTP %s rejection', async status => {
    vi.mocked(api.ingestCsv).mockRejectedValueOnce(new ApiError(status, 'Synthetic rejection')); await mount(); selectFile();
    await screen.findByText('CSV upload was not accepted. Synthetic rejection');
    expect(screen.queryByText(/CSV submission unconfirmed/)).toBeNull();
    expect(sessionStorage.getItem('crw.csv-submission-unconfirmed:test-workspace')).toBeNull(); selectFile(csvFile('corrected.csv'));
    await screen.findByText('1 record imported.'); expect(api.ingestCsv).toHaveBeenCalledTimes(2);
  });
  it('locks concurrent file changes until the acknowledgement arrives, without changing accepted Job recovery', async () => {
    const pending = deferred<ReturnType<typeof syntheticJob>>(); vi.mocked(api.ingestCsv).mockReturnValueOnce(pending.promise);
    await mount(); selectFile(); selectFile(); expect(api.ingestCsv).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(syntheticJob({ job_type: 'CSV_INGEST' })));
    await screen.findByText('1 record imported.'); expect(api.getJob).toHaveBeenCalledWith('job-1');
    expect(sessionStorage.getItem('crw.csv-submission-unconfirmed:test-workspace')).toBeNull();
    expect(screen.queryByText(/CSV submission unconfirmed/)).toBeNull();
    selectFile(csvFile('next.csv')); await waitFor(() => expect(api.ingestCsv).toHaveBeenCalledTimes(2));
  });
  it('confirmed failed Jobs allow a corrected file without uncertainty confirmation', async () => {
    vi.mocked(api.getJob).mockResolvedValueOnce(syntheticJob({ job_type: 'CSV_INGEST', status: 'FAILED', failure_message: 'Synthetic invalid row' }));
    await mount(); selectFile(); await screen.findByText('No records were imported. Synthetic invalid row');
    selectFile(csvFile('corrected.csv')); await screen.findByText('1 record imported.');
    expect(api.ingestCsv).toHaveBeenCalledTimes(2); expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('a second unknown acknowledgement requires another informed confirmation', async () => {
    vi.mocked(api.ingestCsv).mockRejectedValue(Error('Lost acknowledgement')); await mount(); selectFile();
    await screen.findByText('CSV submission unconfirmed: synthetic.csv'); selectFile(csvFile('second.csv'));
    fireEvent.click(screen.getByRole('button', { name: 'I understand; submit new upload' }));
    await screen.findByText('CSV submission unconfirmed: synthetic.csv');
    await waitFor(() => expect(screen.getByRole('button', { name: /^Upload CSV$/ }).hasAttribute('disabled')).toBe(false));
    selectFile(csvFile('third.csv'));
    expect(screen.getByRole('dialog', { name: 'Submit another CSV?' })).toBeTruthy(); expect(api.ingestCsv).toHaveBeenCalledTimes(2);
  });
  it('workspace changes discard old confirmation and stale failure without locking the new workspace', async () => {
    const pending = deferred<ReturnType<typeof syntheticJob>>(); vi.mocked(api.ingestCsv).mockReturnValueOnce(pending.promise);
    const view = await mount(); selectFile(); transition(view, 'workspace change');
    await act(async () => pending.reject(Error('Old acknowledgement failure')));
    expect(screen.queryByText(/CSV submission unconfirmed/)).toBeNull();
    vi.mocked(api.ingestCsv).mockRejectedValueOnce(new ApiError(422, 'Current rejection')); selectFile();
    await screen.findByText('CSV upload was not accepted. Current rejection'); expect(api.ingestCsv).toHaveBeenCalledTimes(2);
  });
});
