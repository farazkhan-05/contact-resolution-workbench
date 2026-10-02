import type { CaseDetail, CaseSummary } from '../types';

export const sampleSummary: CaseSummary = {
  id: 'case-1', case_number: 'SAMPLE-001', source_identifier: 'Synthetic sample',
  person_name: 'Claire Reynolds', employer: 'Acme Health Group Inc', location: 'Boston, MA',
  routing_status: 'LIKELY_MATCH', review_decision: 'PENDING', top_score: 95,
  top_candidate_name: 'Claire Reynolds', has_serious_contradiction: false, candidate_count: 1,
  last_activity_at: '2026-10-03T08:00:00Z', created_at: '2026-10-03T08:00:00Z',
};
export const sampleDetail: CaseDetail = {
  id: sampleSummary.id, case_number: sampleSummary.case_number, source_identifier: sampleSummary.source_identifier,
  raw_name: sampleSummary.person_name, normalized_name: 'claire reynolds',
  name_prefix: null, first_name: 'Claire', middle_name: null, last_name: 'Reynolds', name_suffix: null,
  raw_email: 'claire.reynolds@acmehealth.demo', normalized_email: 'claire.reynolds@acmehealth.demo',
  raw_phone: null, normalized_phone: null, raw_employer: sampleSummary.employer, normalized_employer: 'acme health group',
  raw_location: sampleSummary.location, normalized_location: 'boston ma',
  routing_status: 'LIKELY_MATCH', routing_explanation: 'Strong name and email evidence with consistent employer and location.',
  review_decision: 'PENDING', selected_candidate_id: null, reviewer_notes: null, reviewed_at: null,
  created_at: sampleSummary.created_at, audit_logs: [],
  candidates: [{
    id: 'candidate-1', provider_source: 'Synthetic registry', provider_record_id: 'synthetic-1',
    name: 'Claire Reynolds', first_name: 'Claire', middle_name: null, last_name: 'Reynolds', name_suffix: null,
    email: 'claire.reynolds@acmehealth.demo', phone: null, employer: sampleSummary.employer,
    job_title: 'Operations Director', location: sampleSummary.location,
    total_score: 95, name_score: 35, email_score: 30, phone_score: 0, employer_score: 20, location_score: 10,
    has_serious_contradiction: false, provenance_summary: 'Synthetic registry', contradictions: [],
    evidence: [
      { id: 'evidence-1', field_name: 'name', source_value: 'Claire Reynolds', candidate_value: 'Claire Reynolds',
        points_awarded: 35, max_points: 35, match_method: 'EXACT', explanation: 'Full name matches after normalization.' },
      { id: 'evidence-2', field_name: 'email', source_value: 'claire.reynolds@acmehealth.demo', candidate_value: 'claire.reynolds@acmehealth.demo',
        points_awarded: 30, max_points: 30, match_method: 'EXACT', explanation: 'Email address matches exactly.' },
    ],
  }],
};
