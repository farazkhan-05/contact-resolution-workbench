import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { api } from './api/client';
import { sampleDetail, sampleSummary } from './test-support/cases';

const auth = vi.hoisted(() => ({ signOutUser: vi.fn(async () => {}), status: 'ready' }));
vi.mock('./auth/AuthProvider', () => ({ useAuth: () => ({ ...auth, workspace: { id: 'test-workspace', role: 'OWNER' } }) }));
vi.mock('./api/telemetry', () => ({ recordUsageEvent: vi.fn() }));
vi.mock('./api/client', async (original) => {
  const actual = await original<typeof import('./api/client')>();
  return { ...actual, api: Object.fromEntries(Object.keys(actual.api).map((key) => [key, vi.fn()])) };
});
beforeEach(() => {
  auth.status = 'ready';
  vi.mocked(api.getCases).mockResolvedValue([]);
  vi.mocked(api.getCase).mockResolvedValue(sampleDetail);
  vi.mocked(api.listSources).mockResolvedValue([]);
  vi.mocked(api.listInvestigations).mockResolvedValue([]);
  vi.mocked(api.ingestSample).mockResolvedValue({ ingested_count: 1, created_count: 1, existing_count: 0, case_ids: ['case-1'] });
  vi.mocked(api.ingestCsv).mockResolvedValue({ id: 'job-1' } as Awaited<ReturnType<typeof api.ingestCsv>>);
  vi.mocked(api.getJob).mockResolvedValue({ status: 'SUCCEEDED', successful_rows: 1 } as Awaited<ReturnType<typeof api.getJob>>);
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
  document.head.innerHTML = '<link rel="icon" href="/exact-existing-favicon.svg">';
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const mountEmpty = async () => { render(<App />); await screen.findByText('No cases yet'); };
const toolbar = () => screen.getByRole('region', { name: 'Cases workspace actions' });

describe('authenticated workbench shell', () => {
  it('shares favicon artwork, separates navigation from workflows and removes duplicate AI entry', async () => {
    await mountEmpty();
    expect(screen.getByText('Contact Resolution Workbench')).toBeTruthy();
    const disclosure = screen.getByText('Synthetic demo data only');
    expect(disclosure.tagName).toBe('FOOTER');
    expect(disclosure.classList.contains('environment-note')).toBe(true);
    expect(disclosure.closest('.global-header')).toBeNull();
    expect(disclosure.closest('.shell-workspace')).toBeNull();
    expect(disclosure.children).toHaveLength(0);
    expect(document.querySelector('.product-logo')?.getAttribute('src')).toBe(document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href);
    const nav = screen.getByRole('navigation', { name: 'Product navigation' });
    expect(within(nav).getByRole('button', { name: 'Cases' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'AI Evidence Extraction' })).toHaveLength(1);
    expect(within(toolbar()).getByRole('button', { name: 'Export Reviewed' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('textbox', { name: 'Search cases' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'All Cases' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Decision filter' })).toBeNull();
    fireEvent.click(within(nav).getByRole('button', { name: 'Sources' }));
    await screen.findByRole('heading', { name: 'Sources / Integrations' });
    expect(within(nav).getByRole('button', { name: 'Sources' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('region', { name: 'Cases workspace actions' })).toBeNull();
    fireEvent.click(within(nav).getByRole('button', { name: 'Cases' }));
    expect(toolbar()).toBeTruthy();
  });

  it.each([
    ['Sources', 'Manage where your records come from.'],
    ['AI Evidence Extraction', 'Use AI to pull useful details from notes or documents.'],
    ['Upload CSV', 'Upload a CSV file with records you want to review.'],
    ['Export Reviewed', 'Download cases that already have a review decision.'],
  ])('%s help appears on hover and keyboard focus with a description relationship', async (label, text) => {
    await mountEmpty();
    const trigger = screen.getByRole('button', { name: `${label} help` });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(trigger);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toBe(text);
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id);
    fireEvent.blur(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(trigger.parentElement!);
    expect(screen.getByRole('tooltip').textContent).toBe(text);
    fireEvent.mouseLeave(trigger.parentElement!);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens the account disclosure, supports keyboard navigation and calls existing sign out', async () => {
    await mountEmpty();
    const trigger = screen.getByRole('button', { name: 'Account menu' });
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const signOut = screen.getByRole('button', { name: 'Sign out' });
    expect(document.activeElement).toBe(signOut);
    fireEvent.keyDown(signOut, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(auth.signOutUser).toHaveBeenCalledTimes(1);
  });

  it('loads samples from the first use workspace and restores all queue controls and evidence', async () => {
    await mountEmpty();
    expect(screen.getByRole('heading', { name: 'Start reviewing cases' })).toBeTruthy();
    vi.mocked(api.getCases).mockResolvedValue([sampleSummary]);
    fireEvent.click(screen.getByRole('button', { name: 'Load sample cases' }));
    await screen.findByRole('heading', { name: 'Claire Reynolds' });
    expect(api.ingestSample).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: 'Search cases' })).toBeTruthy();
    for (const name of ['All Cases', 'Likely Match', 'Needs Review', 'No Match']) expect(screen.getByRole('button', { name })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Evidence Comparison & Scoring' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Reviewer Decision Console' })).toBeTruthy();
  });

  it('uses the same file input and ingestion action from the empty workspace', async () => {
    await mountEmpty();
    const input = screen.getByLabelText('Upload CSV file');
    const click = vi.spyOn(input, 'click');
    fireEvent.click(within(document.querySelector('.workspace-empty') as HTMLElement).getByRole('button', { name: 'Upload CSV' }));
    expect(click).toHaveBeenCalledTimes(1);
    const file = new File(['case_number,full_name\nCSV-1,Example'], 'records.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByText('1 record imported.');
    expect(api.ingestCsv).toHaveBeenCalledWith(file);
    expect(api.getJob).toHaveBeenCalledWith('job-1');
  });

  it.each([
    ['CSV contains unsupported columns.', 'No records were imported. CSV contains unsupported columns.'],
    ['A case number in this CSV already exists in this workspace.', 'No records were imported. A case number in this CSV already exists in this workspace.'],
    ['Could not save the CSV. Try again.', 'No records were imported. Could not save the CSV. Try again.'],
  ])('shows the durable CSV failure: %s', async (failure_message, message) => {
    await mountEmpty();
    vi.mocked(api.getJob).mockResolvedValue({ status: 'FAILED', successful_rows: 0, failure_message } as Awaited<ReturnType<typeof api.getJob>>);
    fireEvent.change(screen.getByLabelText('Upload CSV file'), { target: { files: [new File(['case_number,full_name'], 'records.csv')] } });
    await screen.findByText(message);
    expect(screen.queryByText(/records imported\./)).toBeNull();
  });

  it('does not show success while the CSV result is pending or unavailable', async () => {
    await mountEmpty();
    let complete!: (job: Awaited<ReturnType<typeof api.getJob>>) => void;
    vi.mocked(api.getJob).mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    fireEvent.change(screen.getByLabelText('Upload CSV file'), { target: { files: [new File(['case_number,full_name'], 'records.csv')] } });
    await screen.findByText('CSV uploaded. Waiting for the import result.');
    expect(screen.queryByText(/record imported\./)).toBeNull();
    complete({ status: 'SUCCEEDED', successful_rows: 2 } as Awaited<ReturnType<typeof api.getJob>>);
    await screen.findByText('2 records imported.');
  });

  it('leaves the import outcome unknown when polling fails', async () => {
    await mountEmpty();
    vi.mocked(api.getJob).mockRejectedValueOnce(new Error('synthetic network failure'));
    fireEvent.change(screen.getByLabelText('Upload CSV file'), { target: { files: [new File(['case_number,full_name'], 'records.csv')] } });
    await screen.findByText('Could not check the import result. Check Jobs before trying again.');
    expect(screen.queryByText(/No records were imported/)).toBeNull();
    expect(screen.queryByText(/record imported\./)).toBeNull();
  });

  it('preserves server side search and filters when a filtered query returns no cases', async () => {
    vi.mocked(api.getCases).mockResolvedValue([sampleSummary]);
    render(<App />);
    await screen.findByRole('heading', { name: 'Claire Reynolds' });
    vi.mocked(api.getCases).mockResolvedValue([]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search cases' }), { target: { value: 'unmatched' } });
    await screen.findByText('No cases match your filters');
    expect(api.getCases).toHaveBeenLastCalledWith({ search: 'unmatched', routing_status: undefined, review_decision: undefined });
    expect(screen.queryByRole('heading', { name: 'Start reviewing cases' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Needs Review' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Decision filter' }), { target: { value: 'ACCEPTED' } });
    await waitFor(() => expect(api.getCases).toHaveBeenLastCalledWith({ search: 'unmatched', routing_status: 'NEEDS_REVIEW', review_decision: 'ACCEPTED' }));
    expect(within(toolbar()).getByRole('button', { name: 'Export Reviewed' }).hasAttribute('disabled')).toBe(false);
  });

  it('keeps workflow actions reachable through a compact toolbar', async () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList);
    await mountEmpty();
    fireEvent.click(screen.getByRole('button', { name: 'More case actions' }));
    expect(screen.getAllByRole('button', { name: 'AI Evidence Extraction' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Load Sample Cases' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'AI Evidence Extraction' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
