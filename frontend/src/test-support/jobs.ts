import type { Job } from '../types';

export function syntheticJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1', workspace_id: 'test-workspace', job_type: 'GEMINI_UNSTRUCTURED_INGEST',
    status: 'PENDING', total_rows: 1, processed_rows: 0, successful_rows: 0, rejected_rows: 0,
    source_label: null, failure_code: null, failure_message: null,
    created_at: new Date().toISOString(), started_at: null, completed_at: null, ...overrides,
  };
}
