import type { CaseDetail } from '../types';
import { workspaceDetail } from './case-workspace';

export const reviewDetail: CaseDetail = { ...workspaceDetail, audit_logs: [
  { id: 'audit-ingested', event_type: 'CASE_INGESTED', actor: 'system', created_at: workspaceDetail.created_at,
    payload: { source: 'Synthetic sample' } },
  { id: 'audit-scored', event_type: 'SCORED_AND_ROUTED', actor: 'system', created_at: '2026-10-03T08:00:01Z',
    payload: { candidate_count: 2, routing_status: 'LIKELY_MATCH' } },
] };
export const secondReviewDetail: CaseDetail = {
  ...reviewDetail, id: 'review-case-2', case_number: 'REVIEW-002', raw_name: 'Jordan Vale', normalized_name: 'jordan vale',
  first_name: 'Jordan', last_name: 'Vale', name_suffix: null, raw_email: 'jordan.vale@synthetic.example', normalized_email: 'jordan.vale@synthetic.example',
  external_record_id: 'original-002', candidates: [{ ...workspaceDetail.candidates[0], id: 'review-candidate-2',
    name: 'Jordan Vale', first_name: 'Jordan', last_name: 'Vale', name_suffix: null, email: 'jordan.vale@synthetic.example',
    evidence: workspaceDetail.candidates[0].evidence.map(field => field.field_name === 'name'
      ? { ...field, source_value: 'Jordan Vale', candidate_value: 'Jordan Vale' }
      : field.field_name === 'email' ? { ...field, source_value: 'jordan.vale@synthetic.example', candidate_value: 'jordan.vale@synthetic.example' } : field),
  }], audit_logs: [],
};
export const reviewedAt = '2026-10-12T09:05:00Z';
