import type { CaseDetail, CaseSummary } from '../types';
import { sampleDetail, sampleSummary } from './cases';

// Offline contract fixtures. These are server results, not client scoring logic.
const primary = {
  ...sampleDetail.candidates[0], name: 'Claire Reynolds Jr.', name_suffix: 'Jr.',
  evidence: sampleDetail.candidates[0].evidence.map(field => field.field_name === 'name'
    ? { ...field, source_value: 'Claire Reynolds Jr.', candidate_value: 'Claire Reynolds Jr.' } : field),
};
const alternate = {
  ...primary, id: 'candidate-alternate', name: 'Claire Reynolds Sr.', name_suffix: 'Sr.',
  provider_source: 'Synthetic alumni directory', provider_record_id: 'alumni-002',
  provenance_summary: 'Synthetic alumni directory · Imported record', total_score: 65, name_score: 20,
  has_serious_contradiction: true,
  contradictions: [{ id: 'suffix-conflict', contradiction_type: 'INCOMPATIBLE_NAME_SUFFIX', severity: 'SERIOUS' as const,
    description: 'The original record has suffix Jr.; this candidate has suffix Sr. Similar details do not resolve this conflict.', blocks_likely_match: true }],
  evidence: primary.evidence.map(field => field.field_name === 'name'
    ? { ...field, id: 'alternate-name', candidate_value: 'Claire Reynolds Sr.', points_awarded: 20, match_method: 'HIGH_SIMILARITY', explanation: 'Base name matches with suffix variation.' } : { ...field, id: `alternate-${field.id}` }),
};
export const workspaceDetail: CaseDetail = {
  ...sampleDetail, raw_name: primary.name, name_suffix: 'Jr.', normalized_name: 'claire reynolds jr.',
  ingestion_mechanism: 'CSV_UPLOAD', received_at: '2026-10-03T07:55:00Z',
  source_id: 'synthetic-source', ingestion_id: 'synthetic-import', external_record_id: 'original-001',
  routing_status: 'LIKELY_MATCH', routing_explanation: 'Strong evidence score with no blocking contradiction.',
  candidates: [primary, alternate],
};
export const emptyCandidateDetail: CaseDetail = {
  ...sampleDetail, id: 'case-empty', case_number: 'SAMPLE-EMPTY', raw_name: 'Morgan Ellis',
  raw_email: null, normalized_email: null, raw_phone: null, normalized_phone: null,
  raw_employer: null, normalized_employer: null, raw_location: null, normalized_location: null,
  routing_status: 'NO_RELIABLE_MATCH', routing_explanation: 'No reliable candidate records were returned.', candidates: [],
};
const longName = 'Alexandria Catherine Montgomery-Wetherington with a long recorded name Jr.';
const longEmail = 'alexandria.catherine.montgomery-wetherington@synthetic-research-organization.example';
const longEmployer = 'Synthetic International Research and Public Records Collaboration Group';
const longLocation = 'A long recorded regional address with additional jurisdiction and office context';
const longFields: Record<string, string | null> = { name: longName, email: longEmail, phone: null, employer: longEmployer, location: longLocation };
export const longDetail: CaseDetail = {
  ...workspaceDetail, id: 'case-long', case_number: 'SAMPLE-LONG',
  raw_name: longName, raw_email: longEmail, raw_employer: longEmployer, raw_location: longLocation,
  normalized_name: longName.toLowerCase(), normalized_email: longEmail, normalized_employer: longEmployer.toLowerCase(), normalized_location: longLocation.toLowerCase(),
  candidates: workspaceDetail.candidates.map((candidate, index) => ({ ...candidate,
    name: index === 0 ? longName : longName.replace('Jr.', 'Sr.'),
    email: longEmail, employer: longEmployer, location: longLocation,
    evidence: candidate.evidence.map(field => ({ ...field, source_value: longFields[field.field_name],
      candidate_value: field.field_name === 'name' && index === 1 ? longName.replace('Jr.', 'Sr.') : longFields[field.field_name],
    })),
  })),
};
export function summaryFor(detail: CaseDetail): CaseSummary {
  return { ...sampleSummary, id: detail.id, case_number: detail.case_number, person_name: detail.raw_name,
    employer: detail.raw_employer, location: detail.raw_location, routing_status: detail.routing_status,
    review_decision: detail.review_decision, candidate_count: detail.candidates.length,
    top_score: detail.candidates[0]?.total_score ?? 0, top_candidate_name: detail.candidates[0]?.name ?? null,
    has_serious_contradiction: detail.candidates[0]?.has_serious_contradiction ?? false };
}
