import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { ChevronDown } from 'lucide-react';
import { Button } from '../ui/Button';
import { InlineFeedback } from '../ui/Feedback';
import './Jobs.css';
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
  return <li className="activity-job">
    <h3>{jobName(job)}</h3>
    <JobStatus compact job={job} error={tracking.error} checking={tracking.checking} onCheck={tracking.checkAgain} />
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
  const unavailable = <div className="activity-read-error">
    <InlineFeedback tone="error"><p>Recent activity unavailable.</p><p>Could not read the latest Job history. Existing work may still be running.</p></InlineFeedback>
    {jobs.length > 0 && <p className="job-muted">Showing the last loaded activity.</p>}
    {!expanded && <Button disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh activity</Button>}
  </div>;
  return <section className="recent-activity" aria-label="Recent activity">
    <Button variant="quiet" className="activity-toggle" aria-expanded={expanded} aria-controls={expanded ? 'recent-activity-content' : undefined} onClick={onToggle}>
      Recent activity{active.length ? ` (${active.length} active)` : ''}<ChevronDown size={16} aria-hidden="true" />
    </Button>
    {error && !expanded && unavailable}
    {expanded && <div id="recent-activity-content" className="activity-content" role="region" aria-label="Recent activity history" tabIndex={0}>
      <div className="activity-toolbar"><p className="job-muted">CSV imports and AI evidence extraction. Active Jobs and the latest 20 completed or failed imports. Completed Cases appear in Cases.</p>
        <div className="activity-actions" role="group" aria-label="Activity reads"><Button disabled={loading} loading={loading} onClick={() => setRefresh(value => value + 1)}>{loading ? 'Checking activity\u2026' : 'Refresh activity'}</Button>
          {onRefreshCases && <Button variant="quiet" onClick={onRefreshCases}>Refresh cases</Button>}</div>
      </div>
      {loading && <p role="status" className="activity-state">Loading recent activity...</p>}
      {error && unavailable}
      {!loading && !error && !jobs.length && <p className="activity-state">No recent imports.</p>}
      <ul className="activity-list" aria-label="Import and extraction Jobs">{[...active, ...recent].map(job => <ActivityJob key={job.id} initial={job} onTerminal={onTerminal} />)}</ul>
    </div>}
  </section>;
}
