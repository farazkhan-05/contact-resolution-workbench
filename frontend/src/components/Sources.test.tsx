import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sources } from "./Sources";
import { StrictMode } from 'react';
import { api } from "../api/client";
import { syntheticJob } from '../test-support/jobs';

vi.mock("../api/client", async (original) => {
  const actual = await original<typeof import("../api/client")>();
  return { ...actual, api: Object.fromEntries(Object.keys(actual.api).map((key) => [key, vi.fn()])) };
});

describe('Source authority and history fidelity', () => {
  it('one-time synthetic credential display is discarded on close and never restored by refresh', async () => {
    vi.mocked(api.createSource).mockResolvedValue({ ...source('new'), api_key: 'SYNTHETIC-NOT-A-CREDENTIAL' });
    render(<Sources owner onReview={vi.fn()} />);
    await screen.findByRole('heading', { name: 'one' });
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Synthetic feed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Source' }));
    const dialog = await screen.findByRole('dialog', { name: 'API key for new' });
    expect(dialog.getAttribute('aria-describedby')).toBe('key-description');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close and discard key' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close and discard key' }));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByText('SYNTHETIC-NOT-A-CREDENTIAL')).toBeNull();
    select('one');
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(api.sourceStatus).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(api.createSource).toHaveBeenCalledTimes(1);
  });

  it('retains explicit rotation confirmation and treats Escape as closing/discarding the one-time display', async () => {
    const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(api.rotateSource).mockResolvedValue({ ...source('one'), api_key: 'SYNTHETIC-NOT-A-CREDENTIAL' });
    render(<Sources owner onReview={vi.fn()} />);
    await screen.findByRole('button', { name: 'View Source one' }); select('one');
    const trigger = screen.getByRole('button', { name: 'Rotate API Key' }); trigger.focus(); fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(trigger);
    expect(confirmation).toHaveBeenCalledExactlyOnceWith('Rotate the API key? The current key will stop working immediately.');
    expect(api.rotateSource).toHaveBeenCalledExactlyOnceWith('one'); confirmation.mockRestore();
  });

  const detail = () => screen.getByRole('region', { name: screen.getByRole('heading', { level: 3, name: /^(one|two|three|disabled|new)$/ }).textContent! });
  it('binds expanded history to its Source and removes previous expanded history', async () => {
    render(<Sources owner onReview={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText(/1\/1 succeeded/)).toHaveLength(3));
    select('one');
    expect(within(detail()).getByRole('cell', { name: /one-run.*one-job/ })).toBeTruthy();
    select('two');
    expect(screen.queryByRole('cell', { name: /one-run/ })).toBeNull();
    expect(within(detail()).getByRole('cell', { name: /two-run.*two-job/ })).toBeTruthy();
  });

  it('does not present expanded failed history as empty history', async () => {
    vi.mocked(api.sourceHistory).mockImplementation(async id => {
      if (id === 'two') throw Error('synthetic history read failure');
      return history(id);
    });
    render(<Sources owner onReview={vi.fn()} />);
    await screen.findByText('History unavailable');
    select('two');
    expect(screen.getByText('History unavailable')).toBeTruthy();
    expect(within(detail()).queryByText('No ingestion history yet.')).toBeNull();
    expect(within(detail()).queryByText('No ingestions received')).toBeNull();
  });

  it('shows loading until history settles, then records for the selected Source', async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.sourceHistory>>>();
    vi.mocked(api.sourceHistory).mockImplementation(id => id === 'one' ? pending.promise : Promise.resolve(history(id)));
    render(<Sources owner onReview={vi.fn()} />);
    await screen.findByRole('heading', { name: 'one' });
    select('one');
    expect(within(detail()).getByText('Loading ingestion history...')).toBeTruthy();
    expect(within(detail()).queryByText(/No ingestion/)).toBeNull();
    expect(within(detail()).queryByText('History unavailable')).toBeNull();
    await act(async () => pending.resolve(history('one')));
    expect(within(detail()).getByRole('cell', { name: /one-run.*one-job/ })).toBeTruthy();
    expect(within(detail()).queryByText(/Loading.*history/)).toBeNull();
    expect(within(detail()).queryByText(/No ingestion/)).toBeNull();
  });

  it('shows empty history only after a successful empty read', async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.sourceHistory>>>();
    vi.mocked(api.sourceHistory).mockImplementation(id => id === 'two' ? pending.promise : Promise.resolve(history(id)));
    render(<Sources owner onReview={vi.fn()} />);
    await screen.findByRole('heading', { name: 'two' });
    select('two');
    expect(within(detail()).queryByText('No ingestion history yet.')).toBeNull();
    await act(async () => pending.resolve([]));
    expect(within(detail()).getByText('No ingestion history yet.')).toBeTruthy();
    expect(within(detail()).queryByText('History unavailable')).toBeNull();
    expect(within(detail()).queryByRole('button', { name: /Retry history read/ })).toBeNull();
  });

  it.each(['records', 'empty'] as const)('retries failed history using reads only and recovers %s', async result => {
    const pending = deferred<Awaited<ReturnType<typeof api.sourceHistory>>>(); let reads = 0;
    vi.mocked(api.sourceHistory).mockImplementation(id => {
      if (id !== 'two') return Promise.resolve(history(id));
      return ++reads === 1 ? Promise.reject(Error('Synthetic history read failure')) : pending.promise;
    });
    render(<Sources owner={false} onReview={vi.fn()} />); await screen.findByText('History unavailable');
    select('two');
    expect(within(detail()).getByRole('alert').textContent).toContain('Could not load ingestion history.');
    const retry = within(detail()).getByRole('button', { name: 'Retry history read for two' });
    fireEvent.click(retry); fireEvent.click(retry);
    await waitFor(() => expect(api.sourceHistory).toHaveBeenCalledTimes(6));
    expect(api.listSources).toHaveBeenCalledTimes(2);
    expect(within(detail()).getByText('Loading ingestion history...')).toBeTruthy();
    expect(within(detail()).queryByText('No ingestion history yet.')).toBeNull();
    await act(async () => pending.resolve(result === 'empty' ? [] : history('two')));
    if (result === 'empty') expect(within(detail()).getByText('No ingestion history yet.')).toBeTruthy();
    else expect(within(detail()).getByRole('cell', { name: /two-run.*two-job/ })).toBeTruthy();
    expect(within(detail()).queryByText('History unavailable')).toBeNull();
    for (const action of [api.createSource, api.rotateSource, api.sourceStatus, api.ingestCsv, api.ingestUnstructured]) expect(action).not.toHaveBeenCalled();
  });

  it('keeps selected Source context when switching during a retry and a history still fails', async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.sourceHistory>>>(); let reads = 0;
    vi.mocked(api.sourceHistory).mockImplementation(id => {
      if (id !== 'two') return Promise.resolve(history(id));
      return ++reads === 1 ? Promise.reject(Error('Synthetic history failure')) : pending.promise;
    });
    render(<Sources owner onReview={vi.fn()} />); await screen.findByText('History unavailable');
    select('two');
    fireEvent.click(screen.getByRole('button', { name: 'Retry history read for two' }));
    select('one');
    await act(async () => pending.reject(Error('Synthetic retry failure')));
    expect(within(detail()).getByRole('cell', { name: /one-run.*one-job/ })).toBeTruthy();
    expect(screen.getAllByRole('table')).toHaveLength(1);
    select('two');
    expect(within(detail()).getByRole('alert').textContent).toContain('Could not load ingestion history.');
    expect(within(detail()).queryByText('No ingestion history yet.')).toBeNull();
  });

  it('reserves management for owners while keeping reviewer history readable', async () => {
    render(<Sources owner={false} onReview={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText(/1\/1 succeeded/)).toHaveLength(3));
    for (const name of ['Create Source', 'Rotate API Key', 'Disable', 'Enable']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByLabelText('Source name')).toBeNull();
    select('one');
    expect(screen.getByRole('cell', { name: /one-run.*one-job/ })).toBeTruthy();
    expect(api.createSource).not.toHaveBeenCalled(); expect(api.rotateSource).not.toHaveBeenCalled(); expect(api.sourceStatus).not.toHaveBeenCalled();
  });

  it('keeps disabled Source status independent of successfully empty history', async () => {
    vi.mocked(api.listSources).mockResolvedValue([{ ...source('disabled'), status: 'DISABLED' }]);
    vi.mocked(api.sourceHistory).mockResolvedValue([]);
    render(<Sources owner onReview={vi.fn()} />);
    await screen.findByRole('button', { name: 'View Source disabled' }); select('disabled');
    expect(within(detail()).getByText('Disabled')).toBeTruthy();
    expect(await screen.findByText(/No ingestions received/)).toBeTruthy(); expect(screen.queryByText('History unavailable')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(api.sourceStatus).toHaveBeenCalledWith('disabled', 'ACTIVE'));
  });

  it('F21 keeps interval refresh locked through pending history reads', async () => {
    vi.useFakeTimers(); const pending = deferred<Awaited<ReturnType<typeof api.sourceHistory>>>();
    vi.mocked(api.sourceHistory).mockReturnValue(pending.promise);
    const view = render(<Sources owner onReview={vi.fn()} />);
    await act(async () => {});
    expect(api.sourceHistory).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(api.listSources).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve([]));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(api.listSources).toHaveBeenCalledTimes(2); view.unmount();
  });

  it('ignores late former-mount history without overwriting new Source results', async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.sourceHistory>>>();
    vi.mocked(api.listSources).mockResolvedValueOnce([source('old')]).mockResolvedValueOnce([source('new')]);
    vi.mocked(api.sourceHistory).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(history('new'));
    const first = render(<Sources owner onReview={vi.fn()} />);
    await waitFor(() => expect(api.sourceHistory).toHaveBeenCalledWith('old')); first.unmount();
    render(<Sources owner onReview={vi.fn()} />);
    await screen.findByText(/1\/1 succeeded/);
    await act(async () => pending.resolve(history('old')));
    expect(screen.queryByRole('heading', { name: 'old' })).toBeNull();
    select('new');
    expect(screen.getByRole('cell', { name: /new-run.*new-job/ })).toBeTruthy(); expect(screen.queryByRole('cell', { name: /old-run/ })).toBeNull();
  });
});

const select = (name: string) => fireEvent.click(screen.getByRole('button', { name: `View Source ${name}` }));
const source = (id: string, name = id) => ({ id, workspace_id: "workspace", name, source_type: "REFERENCE" as const, status: "ACTIVE" as const, key_prefix: "safe", last_ingested_at: '2026-10-04T00:00:00Z' });
const history = (id: string) => [{ id: `${id}-run`, source_id: id, created_at: "2026-10-04T00:00:00Z", job: { id: `${id}-job`, status: "SUCCEEDED", successful_rows: 1, total_rows: 1, rejected_rows: 0 } } as never];
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.mocked(api.listSources).mockResolvedValue([source("one"), source("two"), source("three")]);
  vi.mocked(api.sourceHistory).mockImplementation(async (id) => history(id));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });

describe("Sources refresh", () => {
  it.each(['success', 'failure'] as const)('F21 ignores an obsolete StrictMode list %s after the current read completes', async (outcome) => {
    const old = deferred<Awaited<ReturnType<typeof api.listSources>>>();
    vi.mocked(api.listSources).mockReturnValueOnce(old.promise).mockResolvedValue([source('new')]);
    render(<StrictMode><Sources owner onReview={vi.fn()} /></StrictMode>);
    await screen.findByRole('button', { name: 'View Source new' }); select('new');
    await screen.findByRole('cell', { name: /new-run.*new-job/ });
    await act(async () => {
      if (outcome === 'success') old.resolve([source('old')]);
      else old.reject(Error('Obsolete synthetic list failure'));
    });
    expect(screen.queryByRole('button', { name: 'View Source old' })).toBeNull();
    expect(screen.getByRole('button', { name: 'View Source new' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.sourceHistory).toHaveBeenCalledExactlyOnceWith('new');
  });

  it('returns to the list without losing records and focuses a newly selected detail', async () => {
    render(<Sources owner onReview={vi.fn()} />);
    await screen.findByRole('button', { name: 'View Source one' }); select('one');
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: 'one' }));
    expect(screen.getByRole('button', { name: 'View Source one' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /Back to Sources/ }));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('button', { name: 'View Source one' }).getAttribute('aria-pressed')).toBe('false');
    select('two');
    expect(screen.getByRole('heading', { level: 3, name: 'two' })).toBe(document.activeElement);
    expect(api.listSources).toHaveBeenCalledTimes(1);
  });

  it('keeps the selected ID through reordering and shows unavailable instead of another Source when removed', async () => {
    vi.useFakeTimers();
    const view = render(<Sources owner onReview={vi.fn()} />);
    await act(async () => {}); select('two');
    vi.mocked(api.listSources).mockResolvedValue([source('three'), source('two'), source('one')]);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByRole('heading', { level: 3, name: 'two' })).toBeTruthy();
    vi.mocked(api.listSources).mockResolvedValue([]);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByRole('heading', { name: 'Source unavailable' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rotate API Key' })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull(); view.unmount();
  });

  it('renders full long names, identifiers and job failure metadata from API data', async () => {
    const longName = 'Long Source name '.repeat(6);
    vi.mocked(api.listSources).mockResolvedValue([source('long-id'.repeat(12), longName)]);
    vi.mocked(api.sourceHistory).mockResolvedValue([{ id: 'long-run', source_id: 'long-id'.repeat(12), created_at: '2026-10-04T00:00:00Z', job: syntheticJob({
      status: 'FAILED', failure_code: 'SYNTHETIC_FAILURE', failure_message: 'Long failure detail '.repeat(20),
    }) }]);
    render(<Sources owner={false} onReview={vi.fn()} />);
    await screen.findByRole('button', { name: `View Source ${longName.trim()}` }); select(longName.trim());
    expect(screen.getByRole('region', { name: longName.trim() }).textContent).toContain('long-id'.repeat(12));
    expect(await screen.findByText('SYNTHETIC_FAILURE')).toBeTruthy();
    expect(screen.getByText('Long failure detail '.repeat(20).trim())).toBeTruthy();
  });

  it("renders all Sources and degrades only the history request that failed", async () => {
    vi.mocked(api.sourceHistory).mockImplementation(async (id) => {
      if (id === "two") throw Error("private internal failure");
      return history(id);
    });
    render(<Sources owner onReview={() => {}} />);
    await screen.findByText("History unavailable");
    expect(screen.getByRole("heading", { name: "one" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "two" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "three" })).toBeTruthy();
    expect(screen.getAllByText(/1\/1 succeeded/).length).toBe(2);
    expect(screen.queryByText("private internal failure")).toBeNull();
  });

  it("keeps one list error at page level", async () => {
    vi.mocked(api.listSources).mockRejectedValueOnce(Error("offline"));
    render(<Sources owner onReview={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load Sources.");
  });

  it("replaces unavailable history with recovered history on the next refresh", async () => {
    vi.mocked(api.sourceHistory).mockRejectedValueOnce(Error("temporary"));
    render(<Sources owner onReview={() => {}} />);
    await screen.findByText("History unavailable");
    vi.mocked(api.sourceHistory).mockImplementation(async (id) => history(id));
    select('one');
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Disable" })); });
    await waitFor(() => expect(screen.queryByText("History unavailable")).toBeNull());
    expect(screen.getAllByText(/1\/1 succeeded/).length).toBe(3);
  });

  it("does not overlap interval refreshes and clears timer and request ownership on unmount", async () => {
    vi.useFakeTimers();
    const pending = deferred<Awaited<ReturnType<typeof api.listSources>>>();
    vi.mocked(api.listSources).mockReturnValueOnce(pending.promise);
    const view = render(<Sources owner onReview={() => {}} />);
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.listSources).toHaveBeenCalledTimes(1);
    view.unmount();
    pending.resolve([source("old")]);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10000);
    expect(api.listSources).toHaveBeenCalledTimes(1);
  });

  it("runs existing source management actions and refreshes after success", async () => {
    render(<Sources owner onReview={() => {}} />);
    await screen.findByRole("heading", { name: "one" });
    select('one');
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(api.sourceStatus).toHaveBeenCalledWith("one", "DISABLED"));
    await waitFor(() => expect(api.listSources).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Open review queue" }));
  });
});

it('provides an owner creation entry point and protects a pending form submission from repeated Enter events', async () => {
  const pending = deferred<Awaited<ReturnType<typeof api.createSource>>>();
  vi.mocked(api.createSource).mockReturnValue(pending.promise);
  render(<Sources owner onReview={vi.fn()} />); await screen.findByRole('button', { name: 'View Source one' });
  const input = screen.getByLabelText('Source name');
  input.scrollIntoView = vi.fn();
  fireEvent.click(screen.getByRole('button', { name: 'Add Source' }));
  expect(document.activeElement).toBe(input); expect(input.scrollIntoView).toHaveBeenCalled();
  fireEvent.change(input, { target: { value: 'Synthetic new feed' } });
  const form = input.closest('form')!;
  fireEvent.submit(form); fireEvent.submit(form);
  expect(api.createSource).toHaveBeenCalledExactlyOnceWith('Synthetic new feed', 'REFERENCE');
  await act(async () => pending.resolve({ ...source('new'), api_key: 'SYNTHETIC-ONE-TIME' }));
  expect(screen.getByRole('dialog', { name: 'API key for new' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close and discard key' }));
  expect(screen.queryByText('SYNTHETIC-ONE-TIME')).toBeNull();
});

it('hides creation entry points from non-owners and keeps Never tied to a null received timestamp', async () => {
  vi.mocked(api.listSources).mockResolvedValue([{ ...source('one'), last_ingested_at: null }]);
  vi.mocked(api.sourceHistory).mockResolvedValue([]);
  render(<Sources owner={false} onReview={vi.fn()} />); await screen.findByRole('button', { name: 'View Source one' });
  select('one'); await screen.findByText('No ingestion history yet.');
  expect(screen.getByText('Never', { exact: true })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Add Source' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Create Source' })).toBeNull();
});
