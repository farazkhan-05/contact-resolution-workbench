import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, sourceIngestionUrl } from "../api/client";
import type { Source, SourceCredential, SourceIngestion } from "../api/client";
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { Field, TextInput } from './ui/Field';
import { InlineFeedback, StatusIndicator } from './ui/Feedback';
import './Sources.css';

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
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const selectionTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (selected) detailHeading.current?.focus();
  }, [selected]);
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
  const source = sources.find((row) => row.id === selected);
  const loadingHistory = (id: string) => historyLoading || (histories[id] === undefined && !historyErrors[id]);
  const returnToList = () => {
    setSelected(null);
    // The list becomes visible after this state update, before focus is restored.
    requestAnimationFrame(() => selectionTrigger.current?.focus());
  };
  return (
    <section className={`sources-workspace${selected ? ' sources-has-selection' : ''}`} aria-label="Sources workspace">
      <header className="sources-heading">
        <div><p className="sources-eyebrow">Workspace records</p><h2>Sources / Integrations</h2>
          <p className="sources-muted">See where records come from and what happened to each ingestion.</p></div>
        <Button onClick={onReview}>Open review queue</Button>
      </header>
      <div className="sources-guide">
        <p><strong>Reference Sources</strong> maintain master records used for comparison.</p>
        <p><strong>Incoming Sources</strong> send records for resolution and human review.</p>
      </div>
      {error && !credential && <InlineFeedback tone="error">{error}</InlineFeedback>}
      {message && !credential && <InlineFeedback tone="success">{message}</InlineFeedback>}
      {loading ? <p role="status" className="sources-state">Loading Sources...</p> : sources.length === 0 && !error && !selected ?
        <div className="sources-state"><h3>No Sources yet.</h3><p className="sources-muted">{owner
          ? "Create a Reference Source, ingest master data, then connect an Incoming Source."
          : "Ask your workspace owner to create a Source."}</p></div> : sources.length === 0 && !selected ?
        <div className="sources-state"><p>Sources are unavailable.</p><Button onClick={() => void load()}>Retry Sources read</Button></div> :
        <div className="sources-master-detail">
          <section className="sources-list" aria-labelledby="sources-list-title">
            <div className="sources-section-heading"><h3 id="sources-list-title">Sources in this workspace</h3><span className="sources-muted">{sources.length}</span></div>
            {sources.map((row) => {
              const latest = histories[row.id]?.[0];
              return <article key={row.id} className="sources-row" data-selected={selected === row.id}>
                <button className="sources-select" aria-pressed={selected === row.id} onClick={(event) => {
                  selectionTrigger.current = event.currentTarget;
                  setSelected(row.id);
                  if (selected === row.id) detailHeading.current?.focus();
                }} aria-label={`View Source ${row.name}`}>
                  <div className="sources-row-heading"><h4>{row.name}</h4><StatusIndicator tone={row.status === 'ACTIVE' ? 'success' : 'neutral'}>{row.status === 'ACTIVE' ? 'Enabled' : 'Disabled'}</StatusIndicator></div>
                  <span className="sources-muted">{row.source_type === 'REFERENCE' ? 'Reference' : 'Incoming'} · {row.key_prefix}...</span>
                  <span className="sources-muted">Last received: {date(row.last_ingested_at)}</span>
                  <span className="sources-recent">Recent result: {loadingHistory(row.id) ? <span>Loading history...</span> : historyErrors[row.id] ? <span>History unavailable</span> : latest
                    ? `${latest.job.status} · ${latest.job.successful_rows}/${latest.job.total_rows} succeeded · ${latest.job.rejected_rows} failed`
                    : 'No ingestions received'}</span>
                  <span className="sources-select-label">{selected === row.id ? 'Viewing Source' : 'View Source →'}</span>
                </button>
              </article>;
            })}
          </section>
          <section className="sources-detail" aria-labelledby="source-detail-title">
            <Button className="sources-back" variant="quiet" onClick={returnToList}>← Back to Sources</Button>
            {!selected ? <div className="sources-state"><h3 id="source-detail-title">Select a Source</h3><p className="sources-muted">View its details, ingestion history and available actions.</p></div> : !source ?
              <div className="sources-state"><h3 id="source-detail-title" ref={detailHeading} tabIndex={-1}>Source unavailable</h3><p className="sources-muted">This Source is no longer in the workspace list. Select another Source or retry the read.</p><Button onClick={() => void load()}>Retry Sources read</Button></div> : <>
                <div className="sources-detail-heading"><div><p className="sources-eyebrow">Selected Source · {source.source_type === 'REFERENCE' ? 'Reference' : 'Incoming'}</p>
                  <h3 id="source-detail-title" tabIndex={-1} ref={detailHeading}>{source.name}</h3></div>
                  <StatusIndicator tone={source.status === 'ACTIVE' ? 'success' : 'neutral'}>{source.status === 'ACTIVE' ? 'Enabled' : 'Disabled'}</StatusIndicator></div>
                <p className="sources-muted">{source.source_type === 'REFERENCE' ? 'Reference records maintain master data used for comparison.' : 'Incoming records create Cases for resolution.'}</p>
                <dl className="sources-metadata"><div><dt>Source ID</dt><dd>{source.id}</dd></div><div><dt>Key prefix</dt><dd>{source.key_prefix}...</dd></div><div><dt>Last received</dt><dd>{date(source.last_ingested_at)}</dd></div></dl>
                <div className="sources-section-heading"><h4>Ingestion history</h4><span className="sources-muted">Most recent first</span></div>
                {loadingHistory(source.id) ? <p role="status" className="sources-state">Loading ingestion history...</p> : historyErrors[source.id] ?
                  <div className="sources-history-failure"><InlineFeedback tone="error">Could not load ingestion history.</InlineFeedback><p className="sources-muted">History is unavailable. Retry reads existing history only.</p><Button onClick={() => void load()} aria-label={`Retry history read for ${source.name}`}>Retry history read</Button></div> : histories[source.id]?.length === 0 ?
                  <p className="sources-state">No ingestion history yet.</p> : <SourceHistory runs={histories[source.id] || []} />}
                {owner && <section className="sources-management" aria-label="Source management">
                  <div className="sources-section-heading"><h4>Manage Source</h4><span className="sources-muted">Owner only</span></div>
                  <div className="sources-management-row"><div><h5>API credentials</h5><p className="sources-muted">New keys are shown once. Rotating stops the current key immediately.</p></div>
                    <Button disabled={busy} onClick={(event) => {
                      credentialTrigger.current = event.currentTarget;
                      if (window.confirm("Rotate the API key? The current key will stop working immediately."))
                        void action(async () => setCredential(await api.rotateSource(source.id)));
                    }}>Rotate API Key</Button></div>
                  <div className="sources-management-row"><div><h5>Receive new records</h5><p className="sources-muted">Disabling stops new ingestion. Existing records and history remain available.</p></div>
                    <Button disabled={busy} onClick={() => void action(async () => {
                      await api.sourceStatus(source.id, source.status === "ACTIVE" ? "DISABLED" : "ACTIVE");
                      setMessage("Source status updated.");
                    })}>{source.status === 'ACTIVE' ? 'Disable' : 'Enable'}</Button></div>
                </section>}
              </>}
          </section>
        </div>}
      {owner && <section className="sources-create" aria-labelledby="create-source-title"><h3 id="create-source-title">Create a Source</h3><p className="sources-muted">Name the feed and choose how its records will be used.</p>
        <form onSubmit={(e) => {
          e.preventDefault();
          credentialTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          void action(async () => { setCredential(await api.createSource(name.trim(), type)); setName(""); });
        }}>
          <Field id="source-name" label="Source name">{(props) => <TextInput {...props} required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name your Source" />}</Field>
          <Field id="source-type" label="Source type">{(props) => <select {...props} className="ui-field-control" value={type} onChange={(e) => setType(e.target.value as Source["source_type"])}><option value="REFERENCE">Reference — master data</option><option value="INCOMING">Incoming — resolution</option></select>}</Field>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>Create Source</Button>
        </form>
      </section>}
      <details className="sources-instructions">
        <summary>Integration instructions</summary>
        <p>Use CSV for onboarding and one-off incoming imports. Use the Source API for ongoing ingestion.</p>
        <p>Send 1-100 canonical records (maximum 256 KB). Use a new Idempotency-Key per batch; repeat it only with the same records. Reference external IDs update within their Source. Incoming batches create Cases. No vendor connectors are installed.</p>
        <pre>{example}</pre>
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


function SourceHistory({ runs }: { runs: SourceIngestion[] }) {
  const labels = ['Ingestion / Job', 'Received', 'Status', 'Records', 'Processed', 'Succeeded', 'Failed', 'Completed'];
  return <table className="sources-history" aria-label="Ingestion history">
    <thead><tr>{labels.map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
    <tbody>{runs.map((run) => <tr key={run.id}>
      <td data-label={labels[0]}><span>{run.id}</span><span className="sources-muted">{run.job.id}</span></td>
      <td data-label={labels[1]}>{date(run.created_at)}</td>
      <td data-label={labels[2]}><StatusIndicator tone={run.job.status === 'SUCCEEDED' ? 'success' : run.job.status === 'FAILED' ? 'error' : 'neutral'}>{run.job.status}</StatusIndicator>
        {run.job.failure_code && <p>{run.job.failure_code}</p>}{run.job.failure_message && <p>{run.job.failure_message}</p>}</td>
      <td data-label={labels[3]}>{run.job.total_rows}</td><td data-label={labels[4]}>{run.job.processed_rows}</td>
      <td data-label={labels[5]}>{run.job.successful_rows}</td><td data-label={labels[6]}>{run.job.rejected_rows}</td>
      <td data-label={labels[7]}>{run.job.completed_at ? date(run.job.completed_at) : 'Not completed'}</td>
    </tr>)}</tbody>
  </table>;
}
