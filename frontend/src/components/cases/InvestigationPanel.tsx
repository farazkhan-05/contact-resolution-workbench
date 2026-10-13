import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import type { InvestigationRun } from '../../types';
import { Button } from '../ui/Button';
import { StatusIndicator } from '../ui/Feedback';
import './InvestigationPanel.css';

type Action = 'STOP' | 'RETRIEVE_SYNTHETIC_NOTES';
type Operation = { phase: 'pending' | 'accepted' | 'unknown'; action?: Action; previous: InvestigationRun | null; run?: InvestigationRun; message?: string };
// Keep a write lock through Case navigation/remounts. Only reads can reconcile an
// uncertain write; no retry of the mutation is scheduled here.
const operations = new Map<string, Operation>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function updateOperation(key: string, value?: Operation) {
  if (value) operations.set(key, value); else operations.delete(key);
  listeners.forEach(listener => listener());
}
const labels = { PENDING: 'Queued', RUNNING: 'Running', WAITING_FOR_HUMAN: 'Waiting for your input', SUCCEEDED: 'Completed', FAILED: 'Failed' };
const readable = (value: string) => value.replaceAll('_', ' ').toLowerCase().replace(/^./, character => character.toUpperCase());
const terminal = (run: InvestigationRun) => ['SUCCEEDED', 'WAITING_FOR_HUMAN', 'FAILED'].includes(run.status);

export function InvestigationPanel({ caseId, eligible, onComplete }: {
  caseId: string; eligible: boolean; onComplete: () => void;
}) {
  const { workspace, status } = useAuth();
  const key = JSON.stringify([workspace?.id, caseId]);
  const operation = useSyncExternalStore(subscribe, () => operations.get(key));
  const [run, setRun] = useState<InvestigationRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const epoch = useRef(0);
  const readId = useRef(0);
  const title = useRef<HTMLHeadingElement>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const ready = status === 'ready' && !!workspace;

  const read = async (session: number, currentRun: InvestigationRun | null, notify = false) => {
    const request = ++readId.current;
    setLoading(true);
    try {
      const next = currentRun ? await api.getInvestigation(currentRun.id) : (await api.listInvestigations(caseId))[0] ?? null;
      if (epoch.current !== session || readId.current !== request) return;
      if (next && (next.case_id !== caseId || (currentRun && next.id !== currentRun.id))) throw new Error('Investigation response does not match this Case.');
      setRun(next); setLoaded(true); setError(null);
      const op = operations.get(key);
      // An unchanged checkpoint or empty history cannot prove an uncertain POST
      // was rejected. Keep its write lock and offer another read.
      const reconciled = op?.phase === 'accepted' || (op?.phase === 'unknown' && next &&
        (op.action ? next.id === op.previous?.id && next.status !== 'WAITING_FOR_HUMAN' : next.id !== op.previous?.id));
      if (reconciled) updateOperation(key);
      if (next && terminal(next) && (notify || reconciled)) onCompleteRef.current();
    } catch (err) {
      if (epoch.current === session && readId.current === request) {
        setError(err instanceof Error && err.message.includes('does not match') ? err.message : 'Could not check investigation status. Read again to confirm the latest state.');
        // Retry only reads of an active run, including repeated read failures.
        if (currentRun) setRun({ ...currentRun });
      }
    } finally {
      if (epoch.current === session && readId.current === request) setLoading(false);
    }
  };
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    const session = ++epoch.current;
    ++readId.current;
    const op = operations.get(key);
    setRun(op?.run ?? op?.previous ?? null); setError(null); setLoaded(false); setLoading(ready);
    if (ready && op?.phase !== 'pending' && op?.phase !== 'accepted') void readRef.current(session, op?.action ? op.previous : null);
    else if (op) setLoading(false);
    return () => { epoch.current = session + 1; };
  }, [key, ready]);

  useEffect(() => {
    if (!ready || operation?.phase === 'pending' || operation?.phase === 'unknown') return;
    const current = operation?.run ?? run;
    if (!current || (!operation && !['PENDING', 'RUNNING'].includes(current.status))) return;
    const session = epoch.current;
    const timer = window.setTimeout(() => { void readRef.current(session, current, true); }, 1500);
    return () => window.clearTimeout(timer);
  }, [run, operation, ready, error]);

  const submit = (action?: Action) => {
    if (!ready || loading || error || operations.has(key) || !loaded) return;
    if (action ? run?.status !== 'WAITING_FOR_HUMAN' || !run.interrupt?.allowed_actions.includes(action)
      : !eligible || (run && ['PENDING', 'RUNNING', 'WAITING_FOR_HUMAN'].includes(run.status))) return;
    ++readId.current;
    const op: Operation = { phase: 'pending', action, previous: run };
    updateOperation(key, op);
    title.current?.focus({ preventScroll: true });
    const promise = action && run ? api.resumeInvestigation(run.id, action) : api.startInvestigation(caseId);
    void promise.then(next => {
      if (next.case_id !== caseId || (action && next.id !== run?.id)) throw new Error('Investigation response does not match this Case.');
      updateOperation(key, { ...op, phase: 'accepted', run: next });
    }).catch(err => {
      updateOperation(key, { ...op, phase: 'unknown', message: err instanceof Error ? err.message : 'Investigation request failed.' });
    });
  };

  const displayed = operation?.run ?? run;
  const unconfirmed = !!error || operation?.phase === 'unknown';
  const waiting = displayed?.status === 'WAITING_FOR_HUMAN';
  const active = displayed && ['PENDING', 'RUNNING', 'WAITING_FOR_HUMAN'].includes(displayed.status);
  const disabled = !ready || loading || !loaded || !!error || !!operation;
  const statusLabel = operation?.phase === 'pending' ? operation.action ? 'Sending continuation request' : 'Starting investigation'
    : operation?.phase === 'accepted' ? operation.action ? 'Continuation accepted; checking status' : 'Start accepted; checking status'
    : unconfirmed ? 'Status unconfirmed' : !ready ? 'Investigation unavailable' : !loaded ? 'Reading investigation status'
    : displayed ? labels[displayed.status] : 'Not started';
  const tone = unconfirmed || waiting ? 'warning' : displayed?.status === 'FAILED' ? 'error'
    : displayed?.status === 'SUCCEEDED' && !operation ? 'success' : active || operation ? 'info' : 'neutral';

  return <section className="investigation-panel" aria-label="Evidence investigation">
    <header className="investigation-heading">
      <h3 ref={title} tabIndex={-1}>Evidence investigation</h3>
      <StatusIndicator role="status" aria-atomic="true" tone={tone}>{statusLabel}</StatusIndicator>
    </header>
    <p className="investigation-intro">Inspect existing evidence and gather approved synthetic notes when available. The final Case review decision stays with you.</p>
    {operation?.phase === 'accepted' && <p>The request was accepted. Waiting for an authoritative status read before showing a confirmed result or another action.</p>}
    {operation?.phase === 'unknown' && <p role="alert">Could not confirm whether the request was accepted. {operation.message} Check status before continuing; this request will not be sent again automatically.</p>}
    {error && <p role="alert">{error}</p>}
    {displayed && <dl className="investigation-facts">
      {unconfirmed && <div><dt>Last reported status</dt><dd>{labels[displayed.status]}</dd></div>}
      {displayed.current_step && <div><dt>Reported step</dt><dd>{readable(displayed.current_step)}</dd></div>}
      {displayed.outcome && <div><dt>{operation || unconfirmed ? 'Last reported outcome' : 'Reported outcome'}</dt><dd>{readable(displayed.outcome)}</dd></div>}
    </dl>}
    {displayed?.last_error_message && <p className="investigation-failure">{displayed.last_error_message}</p>}
    {waiting && <div className="investigation-checkpoint">
      <h4>Human checkpoint</h4>
      {displayed.interrupt ? <>
        <p>{displayed.interrupt.reason}</p>
        <p><strong>Evidence gap:</strong> {readable(displayed.interrupt.evidence_gap)}</p>
      </> : <p>Checkpoint details are unavailable. Refresh the investigation status to check available actions.</p>}
      <p>Choose whether to retrieve more approved notes or finish this investigation. Neither action accepts an identity match.</p>
      <div className="investigation-actions">
        {displayed.interrupt?.allowed_actions.filter((action): action is Action => action === 'STOP' || action === 'RETRIEVE_SYNTHETIC_NOTES').map(action =>
          <Button key={action} disabled={disabled} loading={operation?.phase === 'pending' && operation.action === action}
            onClick={() => submit(action)}>
            {action === 'STOP' ? 'Finish investigation; return to review' : 'Retrieve synthetic notes and resume'}
          </Button>)}
      </div>
    </div>}
    {!operation && !unconfirmed && displayed?.status === 'SUCCEEDED' && <p>Investigation completed. Review the available field evidence in the Case comparison. Completion does not mean a human has accepted an identity match.</p>}
    {!operation && !unconfirmed && displayed?.status === 'FAILED' && <p>The investigation failed. Review the available Case evidence before deciding whether to start another investigation.</p>}
    {!operation && !unconfirmed && active && !waiting && <p>{displayed.status === 'PENDING' ? 'The investigation is queued.' : 'The investigation is running.'} Waiting for reported evidence or a human checkpoint.</p>}
    {!displayed && loaded && !operation && !error && <p>No investigation is recorded for this Case.</p>}
    {!ready && <p>Investigation actions require an active, authorized workspace session.</p>}
    {ready && !eligible && !active && <p>Starting an investigation requires an unresolved Case that needs review.</p>}
    <div className="investigation-actions">
      {eligible && !active && <Button disabled={disabled} loading={operation?.phase === 'pending' && !operation.action} onClick={() => submit()}>{displayed ? 'Start another investigation' : 'Start evidence investigation'}</Button>}
      <Button variant="quiet" loading={loading} disabled={!ready || loading || operation?.phase === 'pending'} onClick={() => {
        title.current?.focus({ preventScroll: true });
        void readRef.current(epoch.current, operation?.phase === 'unknown' && !operation.action ? null : displayed, true);
      }}>{loading ? 'Reading status…' : 'Refresh investigation status'}</Button>
    </div>
  </section>;
}
