import { useId } from 'react';
import type { Job } from '../../types';
import { failureText, isLongRunning, jobDate, jobLabels, jobName } from './jobPresentation';
import { InlineFeedback, StatusIndicator } from '../ui/Feedback';
import { Button } from '../ui/Button';
import './Jobs.css';

export function JobStatus({ job, error, checking, onCheck, compact = false }: { job: Job; error: boolean; checking: boolean; onCheck: () => void; compact?: boolean }) {
  const active = job.status === 'PENDING' || job.status === 'RUNNING';
  const referenceId = useId();
  const recoveryId = useId();
  const times = <>
    {job.started_at && <div><dt>Started</dt><dd>{jobDate(job.started_at)}</dd></div>}
    {job.completed_at && <div><dt>Finished</dt><dd>{jobDate(job.completed_at)}</dd></div>}
  </>;
  return <div className={`job-status${compact ? ' job-status-compact' : ''}`}>
    <div className="job-status-line">
      <StatusIndicator role="status" tone={error ? 'warning' : job.status === 'SUCCEEDED' ? 'success' : job.status === 'FAILED' ? 'error' : 'info'}>{error ? `Last known status: ${jobLabels[job.status]}` : jobLabels[job.status]}</StatusIndicator>
      {(active || error) && <Button loading={checking} onClick={onCheck} aria-describedby={`${referenceId}${error ? ` ${recoveryId}` : ''}`}>{checking ? 'Checking status…' : 'Check Job status'}</Button>}
    </div>
    {active && !error && (!compact || job.status === 'PENDING') && <p>{job.status === 'PENDING' ? 'Accepted and waiting to start.' : 'Processing records. Waiting for the result.'}</p>}
    {job.status === 'SUCCEEDED' && <p>{error && 'Last confirmed result: '}{jobName(job)} completed.{typeof job.successful_rows === 'number' && <> {job.successful_rows} {job.successful_rows === 1 ? 'record' : 'records'} imported.</>}</p>}
    {job.status === 'FAILED' && <InlineFeedback tone="error"><p>{error && 'Last confirmed result: '}{jobName(job)} failed.</p><p>{failureText(job)}</p></InlineFeedback>}
    {active && !error && isLongRunning(job) && <p className="job-muted">This is taking longer than expected.</p>}
    {error && <div className="job-read-error">
      <InlineFeedback tone="error">{active ? 'The Job was accepted, but its latest processing status could not be confirmed.' : 'Could not check the latest status. The last confirmed result is shown.'}</InlineFeedback>
      <p id={recoveryId} className="job-muted">Check Job status reads this Job only. It does not submit another import or extraction.</p>
    </div>}
    {typeof job.processed_rows === 'number' && <p className="job-counts">{error ? 'Last reported records' : 'Records processed'}: {job.processed_rows}{typeof job.total_rows === 'number' && <> of {job.total_rows}</>}.
      {job.rejected_rows > 0 && <> Rejected: {job.rejected_rows}.</>}</p>}
    {compact ? <>
      <div className="job-context"><p id={referenceId}>Job reference: <span>{job.id}</span></p><p>Created {jobDate(job.created_at)}</p></div>
      {(job.started_at || job.completed_at) && <details className="job-times"><summary>Processing timestamps</summary><dl className="job-facts">{times}</dl></details>}
    </> : <dl className="job-facts">
      <div><dt>Job reference</dt><dd id={referenceId}>{job.id}</dd></div>
      <div><dt>Created</dt><dd>{jobDate(job.created_at)}</dd></div>
      {times}
    </dl>}
  </div>;
}
