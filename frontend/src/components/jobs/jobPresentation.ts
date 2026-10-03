import type { Job } from '../../types';

export const isOrdinaryJob = (job: Job) => job.job_type === 'CSV_INGEST' || job.job_type === 'GEMINI_UNSTRUCTURED_INGEST';
export const jobName = (job: Job) => job.job_type === 'CSV_INGEST' ? 'CSV import' : 'AI evidence extraction';
export const jobLabels = { PENDING: 'Queued', RUNNING: 'Running', SUCCEEDED: 'Completed', FAILED: 'Failed' };
export const isLongRunning = (job: Job, now = Date.now()) =>
  (job.status === 'PENDING' || job.status === 'RUNNING') && now - Date.parse(job.started_at || job.created_at) >= 120_000;
export const failureText = (job: Job) => {
  if (job.failure_code === 'INVALID_EXTRACTION') return 'No useful contact evidence was found in this text.';
  if (job.failure_code === 'RATE_LIMITED') return 'Evidence extraction is busy right now. Please try again shortly.';
  if (job.failure_code === 'PROVIDER_TIMEOUT') return 'Evidence extraction is temporarily unavailable. Please try again.';
  return 'Check your input before starting a new attempt.';
};
