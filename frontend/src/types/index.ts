export type RoutingStatus = 'LIKELY_MATCH' | 'NEEDS_REVIEW' | 'NO_RELIABLE_MATCH';

export type ReviewDecision = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'NEED_MORE_EVIDENCE';

export type ContradictionSeverity = 'SERIOUS' | 'MODERATE';

export interface CaseSummary {
  id: string;
  case_number: string;
  source_identifier: string | null;
  person_name: string;
  employer: string | null;
  location: string | null;
  routing_status: RoutingStatus;
  review_decision: ReviewDecision;
  top_score: number;
  top_candidate_name: string | null;
  has_serious_contradiction: boolean;
  candidate_count: number;
  last_activity_at: string;
  created_at: string;
}

export interface MatchEvidence {
  id: string;
  field_name: string;
  source_value: string | null;
  candidate_value: string | null;
  points_awarded: number;
  max_points: number;
  match_method: string;
  explanation: string;
}

export interface Contradiction {
  id: string;
  contradiction_type: string;
  severity: ContradictionSeverity;
  description: string;
  blocks_likely_match: boolean;
}

export interface CandidateDetail {
  id: string;
  provider_source: string;
  provider_record_id: string;
  name: string;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  name_suffix: string | null;
  email: string | null;
  phone: string | null;
  employer: string | null;
  job_title: string | null;
  location: string | null;
  total_score: number;
  name_score: number;
  email_score: number;
  phone_score: number;
  employer_score: number;
  location_score: number;
  has_serious_contradiction: boolean;
  provenance_summary: string;
  evidence: MatchEvidence[];
  contradictions: Contradiction[];
}

export interface AuditEvent {
  id: string;
  event_type: string;
  actor: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface CaseDetail {
  id: string;
  case_number: string;
  source_identifier: string | null;
  raw_name: string;
  normalized_name: string;
  name_prefix: string | null;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  name_suffix: string | null;
  raw_email: string | null;
  normalized_email: string | null;
  raw_phone: string | null;
  normalized_phone: string | null;
  raw_employer: string | null;
  normalized_employer: string | null;
  raw_location: string | null;
  normalized_location: string | null;
  routing_status: RoutingStatus;
  routing_explanation: string;
  review_decision: ReviewDecision;
  selected_candidate_id: string | null;
  reviewer_notes: string | null;
  reviewed_at: string | null;
  created_at: string;
  candidates: CandidateDetail[];
  audit_logs: AuditEvent[];
}

export interface SampleIngestResponse {
  ingested_count: number;
  created_count: number;
  existing_count: number;
  case_ids: string[];
}

export interface Job {
  id: string;
  workspace_id: string;
  job_type: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  total_rows: number | null;
  processed_rows: number;
  successful_rows: number;
  rejected_rows: number;
  source_label: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface DecisionPayload {
  decision: ReviewDecision;
  selected_candidate_id?: string | null;
  notes?: string | null;
}

export interface ExtractedCandidateProfile {
  name: string | null;
  email: string | null;
  phone: string | null;
  employer: string | null;
  job_title: string | null;
  location: string | null;
}

export interface UnstructuredIngestRequest {
  case_number?: string;
  raw_evidence_text: string;
  source_identifier?: string;
}

export interface UnstructuredIngestResponse {
  case_id: string;
  case_number: string;
  extracted_profile: ExtractedCandidateProfile;
  routing_status: RoutingStatus;
  top_score: number;
  candidate_count: number;
}

