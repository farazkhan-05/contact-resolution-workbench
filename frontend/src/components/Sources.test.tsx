import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sources } from "./Sources";
import { api } from "../api/client";

vi.mock("../api/client", async (original) => {
  const actual = await original<typeof import("../api/client")>();
  return { ...actual, api: Object.fromEntries(Object.keys(actual.api).map((key) => [key, vi.fn()])) };
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
