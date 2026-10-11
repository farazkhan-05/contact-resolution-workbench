import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sources } from "./Sources";
import { api } from "../api/client";

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
    fireEvent.click(screen.getAllByRole('button', { name: 'Disable' })[0]);
    await waitFor(() => expect(api.sourceStatus).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(api.createSource).toHaveBeenCalledTimes(1);
  });

  it('retains explicit rotation confirmation and treats Escape as closing/discarding the one-time display', async () => {
    const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(api.rotateSource).mockResolvedValue({ ...source('one'), api_key: 'SYNTHETIC-NOT-A-CREDENTIAL' });
    render(<Sources owner onReview={vi.fn()} />);
    const trigger = (await screen.findAllByRole('button', { name: 'Rotate API Key' }))[0]; trigger.focus(); fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(trigger);
    expect(confirmation).toHaveBeenCalledExactlyOnceWith('Rotate the API key? The current key will stop working immediately.');
    expect(api.rotateSource).toHaveBeenCalledExactlyOnceWith('one'); confirmation.mockRestore();
  });

  const article = (name: string) => screen.getByRole('heading', { name }).closest('article')!;
  it('binds expanded history to its Source and removes previous expanded history', async () => {
    render(<Sources owner onReview={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText(/1\/1 succeeded/)).toHaveLength(3));
    fireEvent.click(within(article('one')).getByRole('button', { name: 'View ingestion history' }));
    expect(within(article('one')).getByRole('cell', { name: /one-run.*one-job/ })).toBeTruthy();
    fireEvent.click(within(article('two')).getByRole('button', { name: 'View ingestion history' }));
    expect(screen.queryByRole('cell', { name: /one-run/ })).toBeNull();
    expect(within(article('two')).getByRole('cell', { name: /two-run.*two-job/ })).toBeTruthy();
  });

  it('does not present expanded failed history as empty history', async () => {
    vi.mocked(api.sourceHistory).mockImplementation(async id => {
      if (id === 'two') throw Error('synthetic history read failure');
      return history(id);
    });
    render(<Sources owner onReview={vi.fn()} />);
    await screen.findByText('History unavailable');
    fireEvent.click(within(article('two')).getByRole('button', { name: 'View ingestion history' }));
    expect(within(article('two')).getByText('History unavailable')).toBeTruthy();
    expect(within(article('two')).queryByText('No ingestion history yet.')).toBeNull();
    expect(within(article('two')).queryByText('No ingestions received')).toBeNull();
  });

  it('shows loading until history settles, then records for the selected Source', async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.sourceHistory>>>();
    vi.mocked(api.sourceHistory).mockImplementation(id => id === 'one' ? pending.promise : Promise.resolve(history(id)));
    render(<Sources owner onReview={vi.fn()} />);
    await screen.findByRole('heading', { name: 'one' });
    fireEvent.click(within(article('one')).getByRole('button', { name: 'View ingestion history' }));
    expect(within(article('one')).getByText('Loading ingestion history...')).toBeTruthy();
    expect(within(article('one')).queryByText(/No ingestion/)).toBeNull();
    expect(within(article('one')).queryByText('History unavailable')).toBeNull();
    await act(async () => pending.resolve(history('one')));
    expect(within(article('one')).getByRole('cell', { name: /one-run.*one-job/ })).toBeTruthy();
    expect(within(article('one')).queryByText(/Loading.*history/)).toBeNull();
    expect(within(article('one')).queryByText(/No ingestion/)).toBeNull();
  });

  it('shows empty history only after a successful empty read', async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.sourceHistory>>>();
    vi.mocked(api.sourceHistory).mockImplementation(id => id === 'two' ? pending.promise : Promise.resolve(history(id)));
    render(<Sources owner onReview={vi.fn()} />);
    await screen.findByRole('heading', { name: 'two' });
    fireEvent.click(within(article('two')).getByRole('button', { name: 'View ingestion history' }));
    expect(within(article('two')).queryByText('No ingestion history yet.')).toBeNull();
    await act(async () => pending.resolve([]));
    expect(within(article('two')).getByText('No ingestion history yet.')).toBeTruthy();
    expect(within(article('two')).queryByText('History unavailable')).toBeNull();
    expect(within(article('two')).queryByRole('button', { name: /Retry history read/ })).toBeNull();
  });

  it.each(['records', 'empty'] as const)('retries failed history using reads only and recovers %s', async result => {
    const pending = deferred<Awaited<ReturnType<typeof api.sourceHistory>>>(); let reads = 0;
    vi.mocked(api.sourceHistory).mockImplementation(id => {
      if (id !== 'two') return Promise.resolve(history(id));
      return ++reads === 1 ? Promise.reject(Error('Synthetic history read failure')) : pending.promise;
    });
    render(<Sources owner={false} onReview={vi.fn()} />); await screen.findByText('History unavailable');
    fireEvent.click(within(article('two')).getByRole('button', { name: 'View ingestion history' }));
    expect(within(article('two')).getByRole('alert').textContent).toContain('Could not load ingestion history.');
    const retry = within(article('two')).getByRole('button', { name: 'Retry history read for two' });
    fireEvent.click(retry); fireEvent.click(retry);
    await waitFor(() => expect(api.sourceHistory).toHaveBeenCalledTimes(6));
    expect(api.listSources).toHaveBeenCalledTimes(2);
    expect(within(article('two')).getByText('Loading ingestion history...')).toBeTruthy();
    expect(within(article('two')).queryByText('No ingestion history yet.')).toBeNull();
    await act(async () => pending.resolve(result === 'empty' ? [] : history('two')));
    if (result === 'empty') expect(within(article('two')).getByText('No ingestion history yet.')).toBeTruthy();
    else expect(within(article('two')).getByRole('cell', { name: /two-run.*two-job/ })).toBeTruthy();
    expect(within(article('two')).queryByText('History unavailable')).toBeNull();
    for (const action of [api.createSource, api.rotateSource, api.sourceStatus, api.ingestCsv, api.ingestUnstructured]) expect(action).not.toHaveBeenCalled();
  });

  it('keeps selected Source context when switching during a retry and a history still fails', async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.sourceHistory>>>(); let reads = 0;
    vi.mocked(api.sourceHistory).mockImplementation(id => {
      if (id !== 'two') return Promise.resolve(history(id));
      return ++reads === 1 ? Promise.reject(Error('Synthetic history failure')) : pending.promise;
    });
    render(<Sources owner onReview={vi.fn()} />); await screen.findByText('History unavailable');
    fireEvent.click(within(article('two')).getByRole('button', { name: 'View ingestion history' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry history read for two' }));
    fireEvent.click(within(article('one')).getByRole('button', { name: 'View ingestion history' }));
    await act(async () => pending.reject(Error('Synthetic retry failure')));
    expect(within(article('one')).getByRole('cell', { name: /one-run.*one-job/ })).toBeTruthy();
    expect(within(article('two')).queryByRole('table')).toBeNull();
    fireEvent.click(within(article('two')).getByRole('button', { name: 'View ingestion history' }));
    expect(within(article('two')).getByRole('alert').textContent).toContain('Could not load ingestion history.');
    expect(within(article('two')).queryByText('No ingestion history yet.')).toBeNull();
  });

  it('reserves management for owners while keeping reviewer history readable', async () => {
    render(<Sources owner={false} onReview={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText(/1\/1 succeeded/)).toHaveLength(3));
    for (const name of ['Create Source', 'Rotate API Key', 'Disable', 'Enable']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByLabelText('Source name')).toBeNull();
    fireEvent.click(within(article('one')).getByRole('button', { name: 'View ingestion history' }));
    expect(screen.getByRole('cell', { name: /one-run.*one-job/ })).toBeTruthy();
    expect(api.createSource).not.toHaveBeenCalled(); expect(api.rotateSource).not.toHaveBeenCalled(); expect(api.sourceStatus).not.toHaveBeenCalled();
  });

  it('keeps disabled Source status independent of successfully empty history', async () => {
    vi.mocked(api.listSources).mockResolvedValue([{ ...source('disabled'), status: 'DISABLED' }]);
    vi.mocked(api.sourceHistory).mockResolvedValue([]);
    render(<Sources owner onReview={vi.fn()} />);
    await screen.findByText(/REFERENCE · DISABLED/);
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
    fireEvent.click(screen.getByRole('button', { name: 'View ingestion history' }));
    expect(screen.getByRole('cell', { name: /new-run.*new-job/ })).toBeTruthy(); expect(screen.queryByRole('cell', { name: /old-run/ })).toBeNull();
  });
});

const source = (id: string, name = id) => ({ id, workspace_id: "workspace", name, source_type: "REFERENCE" as const, status: "ACTIVE" as const, key_prefix: "safe", last_ingested_at: null });
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
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Disable" })[0]); });
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
    fireEvent.click(screen.getAllByRole("button", { name: "Disable" })[0]);
    await waitFor(() => expect(api.sourceStatus).toHaveBeenCalledWith("one", "DISABLED"));
    await waitFor(() => expect(api.listSources).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Open review queue" }));
  });
});
