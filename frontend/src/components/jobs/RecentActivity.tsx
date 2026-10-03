import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { Job } from '../../types';
import { JobStatus } from './JobStatus';
import { isOrdinaryJob, jobName } from './jobPresentation';
import { useJobStatus } from './useJobStatus';

function ActivityJob({ initial, onTerminal }: { initial: Job; onTerminal: (job: Job) => void }) {
  const tracking = useJobStatus(initial, true);
  const job = tracking.job || initial;
  useLayoutEffect(() => {
    if ((job.status === 'SUCCEEDED' || job.status === 'FAILED') && job.status !== initial.status) onTerminal(job);
  }, [job, initial, onTerminal]);
  return <li className="rounded border border-border p-3 space-y-2">
    <h3 className="font-semibold text-sm">{jobName(job)}</h3>
    <p className="text-xs text-muted">Created {new Date(job.created_at).toLocaleString()}</p>
    {job.started_at && <p className="text-xs text-muted">Started {new Date(job.started_at).toLocaleString()}</p>}
    {job.completed_at && <p className="text-xs text-muted">Finished {new Date(job.completed_at).toLocaleString()}</p>}
    <JobStatus job={job} error={tracking.error} checking={tracking.checking} onCheck={tracking.checkAgain} />
  </li>;
}

export function RecentActivity({ workspaceId, revision, expanded, onToggle, onRefreshCases }: { workspaceId: string; revision: number; expanded: boolean; onToggle: () => void; onRefreshCases?: () => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const onTerminal = useCallback((next: Job) => {
    setJobs(current => current.map(job => job.id === next.id && job.workspace_id === next.workspace_id ? next : job));
  }, []);
  useLayoutEffect(() => {
    const owner = ++generation.current;
    setLoading(true);
    void api.listJobs().then(result => {
      if (generation.current !== owner) return;
      setJobs(result.filter(job => job.workspace_id === workspaceId && isOrdinaryJob(job)));
      setError(false);
    }).catch(() => { if (generation.current === owner) setError(true); })
      .finally(() => { if (generation.current === owner) setLoading(false); });
    return () => { generation.current += 1; };
  }, [workspaceId, revision, refresh, expanded]);
  const active = jobs.filter(job => job.status === 'PENDING' || job.status === 'RUNNING');
  const recent = jobs.filter(job => job.status === 'FAILED' || job.status === 'SUCCEEDED').slice(0, 20);
  return <section className="shrink-0 border-b border-border bg-surface px-4 py-2" aria-label="Recent activity">
    <button type="button" className="shell-button" aria-expanded={expanded} aria-controls="recent-activity-content" onClick={onToggle}>Recent activity{active.length ? ` (${active.length} active)` : ''}</button>
    {error && <p role="alert" className="text-xs">Could not check the latest status. <button type="button" onClick={() => setRefresh(value => value + 1)} disabled={loading}>Check again</button></p>}
    {expanded && <div id="recent-activity-content" className="max-h-72 overflow-y-auto space-y-2 py-2">
      <p className="text-xs text-muted">Active imports and the latest 20 completed or failed imports. Completed cases appear in Cases.</p>
      <button type="button" className="shell-button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>{loading ? 'Checking status…' : 'Check again'}</button>
      {onRefreshCases && <button type="button" className="shell-button" onClick={onRefreshCases}>Refresh cases</button>}
      {!loading && !error && !jobs.length && <p className="text-xs">No recent imports.</p>}
      <ul className="grid gap-2 md:grid-cols-2">{[...active, ...recent].map(job => <ActivityJob key={job.id} initial={job} onTerminal={onTerminal} />)}</ul>
    </div>}
  </section>;
}
