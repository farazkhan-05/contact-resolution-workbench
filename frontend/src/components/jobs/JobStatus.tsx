import type { Job } from '../../types';
import { failureText, isLongRunning, jobLabels, jobName } from './jobPresentation';
import { StatusIndicator } from '../ui/Feedback';
import { Button } from '../ui/Button';

export function JobStatus({ job, error, checking, onCheck }: { job: Job; error: boolean; checking: boolean; onCheck: () => void }) {
  const active = job.status === 'PENDING' || job.status === 'RUNNING';
  return <div className="space-y-2 text-sm">
    <StatusIndicator role="status" tone={error ? 'warning' : job.status === 'SUCCEEDED' ? 'success' : job.status === 'FAILED' ? 'error' : 'info'}>{error ? `Last known status: ${jobLabels[job.status]}` : jobLabels[job.status]}</StatusIndicator>
    {job.status === 'SUCCEEDED' && <p>{jobName(job)} completed. {job.successful_rows} {job.successful_rows === 1 ? 'record' : 'records'} imported.</p>}
    {job.status === 'FAILED' && <div role="alert"><p>{jobName(job)} failed.</p><p>{failureText(job)}</p></div>}
    {active && isLongRunning(job) && <p>This is taking longer than expected.</p>}
    {error && <p role="alert">Could not check the latest status. The outcome is unknown.</p>}
    {(active || error) && <Button loading={checking} onClick={onCheck}>{checking ? 'Checking status…' : 'Check again'}</Button>}
  </div>;
}
