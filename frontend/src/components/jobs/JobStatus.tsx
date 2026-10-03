import type { Job } from '../../types';
import { failureText, isLongRunning, jobLabels, jobName } from './jobPresentation';

export function JobStatus({ job, error, checking, onCheck }: { job: Job; error: boolean; checking: boolean; onCheck: () => void }) {
  const active = job.status === 'PENDING' || job.status === 'RUNNING';
  return <div className="space-y-2 text-xs">
    <p role="status">{error ? `Last known status: ${jobLabels[job.status]}` : jobLabels[job.status]}</p>
    {job.status === 'SUCCEEDED' && <p>{jobName(job)} completed. {job.successful_rows} {job.successful_rows === 1 ? 'record' : 'records'} imported.</p>}
    {job.status === 'FAILED' && <div role="alert"><p>{jobName(job)} failed.</p><p>{failureText(job)}</p></div>}
    {active && isLongRunning(job) && <p role="status">This is taking longer than expected.</p>}
    {error && <p role="alert">Could not check the latest status. The outcome is unknown.</p>}
    {(active || error) && <button type="button" className="shell-button shell-button-bordered" disabled={checking} onClick={onCheck}>{checking ? 'Checking status…' : 'Check again'}</button>}
  </div>;
}
