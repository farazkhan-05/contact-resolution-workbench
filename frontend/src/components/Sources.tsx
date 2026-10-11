import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, sourceIngestionUrl } from "../api/client";
import type { Source, SourceCredential, SourceIngestion } from "../api/client";
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { TextInput } from './ui/Field';
import { InlineFeedback } from './ui/Feedback';

const button =
  "rounded border border-border bg-surface px-3 py-2 text-sm hover:bg-surface-muted disabled:opacity-50";
const date = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "Never";
const example = String.raw`curl -X POST ${sourceIngestionUrl} \
  -H "Authorization: Bearer <SOURCE_API_KEY>" \
  -H "Idempotency-Key: example-001" \
  -H "Content-Type: application/json" \
  -d '{"records":[{"external_record_id":"customer-1842","full_name":"Alex Example","old_email":"alex@example.test","employer":"Example Company"}]}'`;

export function Sources({
  owner,
  onReview,
}: {
  owner: boolean;
  onReview: () => void;
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [histories, setHistories] = useState<Record<string, SourceIngestion[]>>(
    {},
  );
  const [historyErrors, setHistoryErrors] = useState<Record<string, boolean>>({});
  const [historyLoading, setHistoryLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<Source["source_type"]>("REFERENCE");
  const [credential, setCredential] = useState<SourceCredential | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const refreshId = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const discardKeyButton = useRef<HTMLButtonElement>(null);
  const credentialTrigger = useRef<HTMLElement | null>(null);
  const load = useCallback(async () => {
    if (!mounted.current || inFlight.current) return;
    inFlight.current = true;
    setHistoryLoading(true);
    const requestId = ++refreshId.current;
    const current = () => mounted.current && refreshId.current === requestId;
    try {
      const rows = await api.listSources();
      if (!current()) return;
      setSources(rows);
      setError("");
      setLoading(false);
      const outcomes = await Promise.allSettled(
        rows.map(async (source) => [source.id, await api.sourceHistory(source.id)] as const),
      );
      if (!current()) return;
      const nextHistories: Record<string, SourceIngestion[]> = {};
      const nextErrors: Record<string, boolean> = {};
      outcomes.forEach((outcome, index) => {
        const sourceId = rows[index].id;
        if (outcome.status === "fulfilled") nextHistories[sourceId] = outcome.value[1];
        else nextErrors[sourceId] = true;
      });
      setHistories(nextHistories);
      setHistoryErrors(nextErrors);
    } catch (err) {
      if (current()) setError(err instanceof ApiError ? err.detail : "Could not load Sources.");
    } finally {
      if (current()) { setLoading(false); setHistoryLoading(false); }
      if (refreshId.current === requestId) inFlight.current = false;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      window.clearInterval(timer);
      mounted.current = false;
      refreshId.current += 1;
      inFlight.current = false;
    };
  }, [load]);
  const action = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.detail : "Source operation failed.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="w-full overflow-auto p-6 text-foreground">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Sources / Integrations</h2>
          <p className="text-sm text-muted">
            Sources → Recent ingestions → Cases needing review
          </p>
        </div>
        <button className={button} onClick={onReview}>
          Open review queue
        </button>
      </div>
      <p className="mb-4 text-sm text-muted">
        Use CSV for onboarding and one-off incoming imports. Use the Source API
        for ongoing ingestion. Reference Sources maintain master records;
        Incoming Sources send records for resolution.
      </p>
      {error && !credential && (
        <p role="alert" className="mb-3 text-rose-700">
          {error}
        </p>
      )}
      {message && !credential && (
        <p role="status" className="mb-3 text-emerald-700">
          {message}
        </p>
      )}
      {owner && (
        <form
          className="mb-5 flex flex-wrap gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            credentialTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            void action(async () => {
              setCredential(await api.createSource(name.trim(), type));
              setName("");
            });
          }}
        >
          <TextInput
            aria-label="Source name"
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="CRM Feed"
            style={{ width: 'auto' }}
          />
          <select
            aria-label="Source type"
            className={button}
            value={type}
            onChange={(e) => setType(e.target.value as Source["source_type"])}
          >
            <option value="REFERENCE">REFERENCE - master data</option>
            <option value="INCOMING">INCOMING - resolution</option>
          </select>
          <button className={button} disabled={busy || !name.trim()}>
            Create Source
          </button>
        </form>
      )}
      {loading ? (
        <p role="status">Loading Sources...</p>
      ) : sources.length === 0 ? (
        <p className="rounded border border-border p-6">
          No Sources yet.{" "}
          {owner
            ? "Create a Reference Source, ingest master data, then connect an Incoming Source."
            : "Ask your workspace owner to create a Source."}
        </p>
      ) : (
        <div className="space-y-3">
          {sources.map((source) => {
            const latest = histories[source.id]?.[0];
            const loadingHistory = historyLoading || (histories[source.id] === undefined && !historyErrors[source.id]);
            return (
              <article
                key={source.id}
                className="rounded border border-border bg-surface p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">{source.name}</h3>
                    <p className="text-sm text-muted">
                      {source.source_type} · {source.status} ·{" "}
                      {source.key_prefix}...
                    </p>
                    <p className="text-xs text-muted">
                      Last received: {date(source.last_ingested_at)}
                    </p>
                    <p className="text-sm">
                      Recent result:{" "}
                      {loadingHistory ? <span role="status">Loading history...</span> : historyErrors[source.id] ? <span role="status">History unavailable</span> : latest
                        ? `${latest.job.status} · ${latest.job.successful_rows}/${latest.job.total_rows} succeeded · ${latest.job.rejected_rows} failed`
                        : "No ingestions received"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className={button}
                      onClick={() =>
                        setSelected(selected === source.id ? null : source.id)
                      }
                    >
                      View ingestion history
                    </button>
                    {owner && (
                      <>
                        <button
                          disabled={busy}
                          className={button}
                          onClick={(event) => {
                            credentialTrigger.current = event.currentTarget;
                            if (
                              window.confirm(
                                "Rotate the API key? The current key will stop working immediately.",
                              )
                            )
                              void action(async () =>
                                setCredential(
                                  await api.rotateSource(source.id),
                                ),
                              );
                          }}
                        >
                          Rotate API Key
                        </button>
                        <button
                          disabled={busy}
                          className={button}
                          onClick={() =>
                            void action(async () => {
                              await api.sourceStatus(
                                source.id,
                                source.status === "ACTIVE"
                                  ? "DISABLED"
                                  : "ACTIVE",
                              );
                              setMessage("Source status updated.");
                            })
                          }
                        >
                          {source.status === "ACTIVE" ? "Disable" : "Enable"}
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {selected === source.id && (
                  <div className="mt-4 overflow-auto">
                    {loadingHistory ? <p role="status">Loading ingestion history...</p> : historyErrors[source.id] ?
                      <div role="alert">
                        <p>Could not load ingestion history.</p>
                        <button className={button} onClick={() => void load()} aria-label={`Retry history read for ${source.name}`}>
                          Retry history read
                        </button>
                      </div> : <>
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr>
                          {[
                            "Ingestion / Job",
                            "Received",
                            "Status",
                            "Records",
                            "Processed",
                            "Succeeded",
                            "Failed",
                            "Completed",
                          ].map((label) => (
                            <th key={label} className="p-2">
                              {label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {histories[source.id]?.map((run) => (
                          <tr key={run.id} className="border-t border-border">
                            <td className="p-2">
                              {run.id}
                              <br />
                              {run.job.id}
                            </td>
                            <td className="p-2">{date(run.created_at)}</td>
                            <td className="p-2">
                              {run.job.status}
                              <br />
                              {run.job.failure_code}
                              {run.job.failure_message && (
                                <p>{run.job.failure_message}</p>
                              )}
                            </td>
                            <td className="p-2">{run.job.total_rows}</td>
                            <td className="p-2">{run.job.processed_rows}</td>
                            <td className="p-2">{run.job.successful_rows}</td>
                            <td className="p-2">{run.job.rejected_rows}</td>
                            <td className="p-2">
                              {date(run.job.completed_at)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {histories[source.id]?.length === 0 && (
                      <p>No ingestion history yet.</p>
                    )}
                    </>}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      <details className="mt-6 rounded border border-border p-4">
        <summary>Integration instructions</summary>
        <p className="my-2 text-sm">
          Send 1-100 canonical records (maximum 256 KB). Use a new
          Idempotency-Key per batch; repeat it only with the same records.
          Reference external IDs update within their Source. Incoming batches
          create Cases. No vendor connectors are installed.
        </p>
        <pre className="overflow-auto rounded bg-surface-muted p-3 text-xs">
          {example}
        </pre>
      </details>
      {credential && (
        <Dialog open onDismiss={() => setCredential(null)} labelledBy="key-title" describedBy="key-description" initialFocusRef={discardKeyButton} returnFocusRef={credentialTrigger}>
          <div className="ui-dialog-body">
            <h3 id="key-title" className="ui-dialog-title">
              API key for {credential.name}
            </h3>
            <p id="key-description">
              Copy this key now. It cannot be shown again.
            </p>
            <code className="block break-all rounded bg-surface-muted p-3 text-sm">
              {credential.api_key}
            </code>
            <div className="flex flex-wrap gap-3">
              <Button
                onClick={() => {
                  void navigator.clipboard.writeText(credential.api_key).then(
                    () => setMessage("API key copied."),
                    () =>
                      setError(
                        "Copy failed. Select the key and copy it manually.",
                      ),
                  );
                }}
              >
                Copy API Key
              </Button>
              <Button ref={discardKeyButton}
                onClick={() => setCredential(null)}
              >
                Close and discard key
              </Button>
            </div>
            {error && <InlineFeedback tone="error">{error}</InlineFeedback>}
            {message && <InlineFeedback tone="success">{message}</InlineFeedback>}
            <p className="text-sm text-muted">
              Use Authorization: Bearer &lt;SOURCE_API_KEY&gt; and an
              Idempotency-Key with the ingestion endpoint. Keep the credential
              in your application's secret storage.
            </p>
          </div>
        </Dialog>
      )}
    </section>
  );
}
