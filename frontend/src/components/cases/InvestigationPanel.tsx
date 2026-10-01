import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import type { InvestigationRun } from '../../types';

export function InvestigationPanel({ caseId, eligible, onComplete }: {
  caseId: string; eligible: boolean; onComplete: () => void;
}) {
  const { workspace, status } = useAuth();
  const [run, setRun] = useState<InvestigationRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    const session = ++epoch.current;
    setRun(null); setError(null); setBusy(false);
    if (status === 'ready') {
      void api.listInvestigations(caseId).then((runs) => {
        if (epoch.current === session) setRun((current) => current ?? runs[0] ?? null);
      }).catch(() => { if (epoch.current === session) setError('Could not load investigations.'); });
    }
    return () => { epoch.current = session + 1; };
  }, [caseId, workspace?.id, status]);

  useEffect(() => {
    if (!run || !['PENDING', 'RUNNING'].includes(run.status) || status !== 'ready') return;
    let active = true;
    const session = epoch.current;
    const timer = window.setTimeout(() => {
      void api.getInvestigation(run.id).then((next) => {
        if (!active || epoch.current !== session) return;
        setRun(next);
        if (['SUCCEEDED', 'WAITING_FOR_HUMAN', 'FAILED'].includes(next.status)) onCompleteRef.current();
      }).catch(() => { if (active && epoch.current === session) { setError('Could not check investigation status. Retrying.'); setRun({ ...run }); } });
    }, 1500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [run, status, workspace?.id]);

  const submit = async (action?: 'STOP' | 'RETRIEVE_SYNTHETIC_NOTES') => {
    const session = epoch.current;
    setBusy(true); setError(null);
    try {
      const next = action && run ? await api.resumeInvestigation(run.id, action) : await api.startInvestigation(caseId);
      if (epoch.current === session) setRun(next);
    } catch (err) {
      if (epoch.current === session) setError(err instanceof Error ? err.message : 'Investigation request failed.');
    } finally { if (epoch.current === session) setBusy(false); }
  };
  const active = run && ['PENDING', 'RUNNING', 'WAITING_FOR_HUMAN'].includes(run.status);
  return <section className="rounded border border-border bg-surface p-4 space-y-2" aria-label="Evidence investigation">
    <h3 className="text-sm font-semibold">Evidence investigation</h3>
    <p className="text-xs text-muted">Inspect approved synthetic evidence. The final review decision stays with you.</p>
    {run && <p className="text-xs" role="status">{run.status.replaceAll('_', ' ')}{run.outcome ? `: ${run.outcome.replaceAll('_', ' ')}` : ''}</p>}
    {run?.last_error_message && <p className="text-xs text-red-700">{run.last_error_message}</p>}
    {run?.interrupt && <div className="text-xs space-y-2">
      <p>{run.interrupt.reason} Gap: {run.interrupt.evidence_gap.replaceAll('_', ' ')}.</p>
      {run.interrupt.allowed_actions.map((action) => <button className="border border-border rounded px-3 py-2 mr-2" disabled={busy} key={action} onClick={() => void submit(action as 'STOP' | 'RETRIEVE_SYNTHETIC_NOTES')}>
        {action === 'STOP' ? 'Finish investigation; return to review' : 'Retrieve synthetic notes and resume'}
      </button>)}
    </div>}
    {eligible && !active && <button className="border border-border rounded px-3 py-2 text-xs" disabled={busy} onClick={() => void submit()}>Start evidence investigation</button>}
    {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
  </section>;
}
