import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { CaseDetail as CaseDetailType, CaseSummary, ReviewDecision } from '../../types';
import { AuditTimeline } from './AuditTimeline';
import { CandidateList } from './CandidateList';
import { ContradictionAlert } from './ContradictionAlert';
import { EvidenceMatrix } from './EvidenceMatrix';
import { AIProvenanceSection } from './AIProvenanceSection';
import { OriginalRecord } from './OriginalRecord';
import { ReviewConsole } from './ReviewConsole';
import { InvestigationPanel } from './InvestigationPanel';
import { Button } from '../ui/Button';
import { StatusIndicator } from '../ui/Feedback';
import { decisionLabel, recommendationLabel, recommendationTone } from './casePresentation';
import './Cases.css';

interface CaseDetailProps {
  caseDetail: CaseDetailType | null;
  selectedCaseId: string | null;
  mobileDetailActive?: boolean;
  selectedCase?: CaseSummary;
  isLoading: boolean;
  onBackMobile: () => void;
  onSubmitDecision: (caseId: string, decision: ReviewDecision, candidateId?: string | null, notes?: string | null) => Promise<void>;
  isSubmittingDecision: boolean;
  isReviewReady: boolean;
  reviewReadbackRequired?: boolean;
  onRefresh: () => void;
  onRetry?: () => void;
}
const mobileQuery = '(max-width: 767px)';
const subscribeMobile = (callback: () => void) => {
  const query = window.matchMedia(mobileQuery);
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
};
const getMobile = () => window.matchMedia(mobileQuery).matches;

export function CaseDetail(props: CaseDetailProps) {
  const { caseDetail, selectedCaseId, selectedCase, isLoading, onBackMobile, onRefresh, onRetry } = props;
  const stateRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (props.mobileDetailActive && getMobile()) stateRef.current?.focus({ preventScroll: true });
  }, [props.mobileDetailActive, selectedCaseId, isLoading, caseDetail]);
  const back = (
    <Button variant="quiet" onClick={onBackMobile} className="case-back">
      <ArrowLeft size={16} aria-hidden="true" />Back to case queue
    </Button>
  );
  if (isLoading || !caseDetail || caseDetail.id !== selectedCaseId) {
    return (
      <section ref={stateRef} tabIndex={-1} className="case-detail-content case-detail-state" aria-label="Selected case">
        {back}
        {selectedCase && (
          <p className="case-metadata">Selected case · {selectedCase.case_number} · {selectedCase.person_name}</p>
        )}
        {isLoading ? <p role="status">Loading case details...</p> : selectedCaseId ? <>
          <h2>Case details unavailable</h2>
          <p>The selected Case could not be loaded. Previous Case evidence is not shown.</p>
          <Button onClick={onRetry || onRefresh}>Retry selected case</Button>
          <p>Load the selected Case before making a decision.</p>
          <div className="case-unavailable-actions">
            <Button disabled>Accept Candidate</Button>
            <Button disabled>Reject All</Button>
            <Button disabled>Need More Evidence</Button>
          </div>
        </> : <>
          <h2>Select a case to inspect</h2>
          <p>Choose a case from the queue to inspect its records and evidence.</p>
        </>}
      </section>
    );
  }
  // A new Case gets its own selection/disclosure state before rendering any evidence.
  return <LoadedCase key={caseDetail.id} {...props} caseDetail={caseDetail} back={back} />;
}

function LoadedCase({
  caseDetail, onSubmitDecision, isSubmittingDecision, isReviewReady, onRefresh, back,
  mobileDetailActive = true, reviewReadbackRequired = false,
}: CaseDetailProps & { caseDetail: CaseDetailType; back: ReactNode }) {
  const initialCandidateId = caseDetail.selected_candidate_id || caseDetail.candidates[0]?.id || null;
  const [selectedCandidateId, setSelectedCandidateId] = useState(initialCandidateId);
  useEffect(() => {
    setSelectedCandidateId(caseDetail.selected_candidate_id || caseDetail.candidates[0]?.id || null);
  }, [caseDetail]);
  const activeCandidate = caseDetail.candidates.find(candidate => candidate.id === selectedCandidateId)
    || caseDetail.candidates[0] || null;
  const compact = useSyncExternalStore(subscribeMobile, getMobile, () => false);
  const [candidatesExpanded, setCandidatesExpanded] = useState(!compact);
  const [evidenceExpanded, setEvidenceExpanded] = useState(!compact);
  const [recordExpanded, setRecordExpanded] = useState(!compact);
  useEffect(() => {
    setCandidatesExpanded(!compact);
    setEvidenceExpanded(!compact);
    setRecordExpanded(!compact);
  }, [compact]);
  const rootRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (compact && mobileDetailActive) titleRef.current?.focus({ preventScroll: true });
  }, [compact, mobileDetailActive]);
  const serious = !!activeCandidate && (activeCandidate.has_serious_contradiction
    || activeCandidate.contradictions.some(conflict => conflict.severity === 'SERIOUS'));
  const gotoReview = () => {
    const target = rootRef.current?.querySelector<HTMLElement>('#case-review-heading');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'start' });
  };
  const gotoEvidence = () => {
    setEvidenceExpanded(true);
    const target = rootRef.current?.querySelector<HTMLElement>('.case-evidence-title');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'start' });
  };
  const gotoCandidates = () => {
    setCandidatesExpanded(true);
    const selector = compact ? '.case-candidate-disclosure > summary' : '.case-candidate-option[aria-pressed="true"]';
    const target = rootRef.current?.querySelector<HTMLElement>(selector);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'start' });
  };
  const gotoHistory = () => {
    const target = rootRef.current?.querySelector<HTMLElement>('#case-history-toggle');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'start' });
  };

  const provenance = (
    <div className="case-provenance">
      {caseDetail.ingestion_mechanism && <span>Source type: {caseDetail.ingestion_mechanism.replaceAll('_', ' ')}</span>}
      {caseDetail.source_identifier && <span>Source: {caseDetail.source_identifier}</span>}
      <span>{caseDetail.received_at ? 'Received' : 'Created'}: {new Date(caseDetail.received_at || caseDetail.created_at).toLocaleString()}</span>
      {(caseDetail.source_id || caseDetail.ingestion_id || caseDetail.external_record_id) && (
        <details>
          <summary>Source details</summary>
          <dl>
            {caseDetail.source_id && <div><dt>Source ID</dt><dd>{caseDetail.source_id}</dd></div>}
            {caseDetail.ingestion_id && <div><dt>Ingestion ID</dt><dd>{caseDetail.ingestion_id}</dd></div>}
            {caseDetail.external_record_id && <div><dt>External record</dt><dd>{caseDetail.external_record_id}</dd></div>}
          </dl>
        </details>
      )}
    </div>
  );

  return (
    <div className="case-detail-content" ref={rootRef}>
      {back}
      <header className="case-heading">
        <div>
          <p className="case-metadata">{caseDetail.case_number} · Incoming record</p>
          <h2 ref={titleRef} tabIndex={-1}>{caseDetail.raw_name}</h2>
          <p className="case-heading-context">
            {[caseDetail.raw_employer, caseDetail.raw_location].filter(Boolean).join(' · ') || 'No organization or location provided'}
          </p>
        </div>
        {!compact && <Button onClick={gotoReview} className="case-go-review">Go to review options</Button>}
      </header>
      {!compact && provenance}
      {caseDetail.ai_provenance && (
        <AIProvenanceSection key={`ai:${caseDetail.id}`} caseId={caseDetail.id} provenance={caseDetail.ai_provenance} />
      )}
      <section className="case-decision-summary" aria-label="Recommendation and human decision">
        <div>
          <h3>System recommendation</h3>
          <StatusIndicator tone={recommendationTone(caseDetail.routing_status)}>
            {recommendationLabel[caseDetail.routing_status]}
          </StatusIndicator>
          <p>{caseDetail.routing_explanation}</p>
        </div>
        <div><h3>Human decision</h3><p>{decisionLabel[caseDetail.review_decision]}</p></div>
      </section>
      {activeCandidate && (
        <ContradictionAlert contradictions={activeCandidate.contradictions} seriousFlag={activeCandidate.has_serious_contradiction} candidateName={activeCandidate.name} />
      )}
      {compact && provenance}
      <details className="case-original-disclosure" open={recordExpanded}
        onToggle={event => setRecordExpanded(event.currentTarget.open)}>
        <summary>Original ingested record</summary>
        <OriginalRecord caseDetail={caseDetail} />
      </details>
      <section className="case-comparison" aria-label="Candidate comparison">
        <div className="case-section-heading">
          <div><p className="case-eyebrow">Identity comparison</p><h3>Compare the source with a candidate</h3></div>
          <p className="case-metadata">
            {activeCandidate ? `Candidate ${caseDetail.candidates.indexOf(activeCandidate) + 1} of ${caseDetail.candidates.length}` : '0 candidates'}
          </p>
        </div>
        {activeCandidate && (
          <div className="case-selected-candidate">
            <div>
              <p className="case-metadata">Selected candidate</p><strong>{activeCandidate.name}</strong>
              <p>{[activeCandidate.employer, activeCandidate.location].filter(Boolean).join(' · ') || activeCandidate.provider_source}</p>
            </div>
            <p><strong>{activeCandidate.total_score}</strong><span>points / 100</span></p>
          </div>
        )}
        <details className="case-candidate-disclosure" open={candidatesExpanded}
          onToggle={event => setCandidatesExpanded(event.currentTarget.open)}>
          <summary>Change candidate <span>{caseDetail.candidates.length} records</span></summary>
          <CandidateList candidates={caseDetail.candidates} selectedCandidateId={activeCandidate?.id || null} onSelectCandidate={setSelectedCandidateId} />
        </details>
      </section>
      {compact && <Button onClick={gotoReview} className="case-go-review">Go to review options</Button>}
      {activeCandidate && (
        <details className="case-evidence-disclosure" open={evidenceExpanded}
          onToggle={event => setEvidenceExpanded(event.currentTarget.open)}>
          <summary>
            <span>
              <span role="heading" aria-level={3} tabIndex={-1} className="case-evidence-title">Evidence Comparison &amp; Scoring</span>
              <span className="case-metadata">{activeCandidate.evidence.length} fields · Original record, {activeCandidate.name}, explanations and points</span>
            </span>
            <span aria-hidden="true">{evidenceExpanded ? '−' : '+'}</span>
          </summary>
          <EvidenceMatrix activeCandidate={activeCandidate} aiExtracted={!!caseDetail.ai_provenance} />
        </details>
      )}
      <div className={`case-review-area${serious ? ' has-serious-conflict' : ''}`}>
        <ReviewConsole caseDetail={caseDetail} activeCandidate={activeCandidate} onSubmitDecision={onSubmitDecision}
          isSubmitting={isSubmittingDecision} isReviewReady={isReviewReady} readbackRequired={reviewReadbackRequired}
          onCheckSavedDecision={onRefresh} onViewEvidence={gotoEvidence}
          onChangeCandidate={gotoCandidates} onViewHistory={gotoHistory} />
      </div>
      <div className="case-operational">
        <InvestigationPanel key={caseDetail.id} caseId={caseDetail.id}
          eligible={caseDetail.routing_status === 'NEEDS_REVIEW' && ['PENDING', 'NEED_MORE_EVIDENCE'].includes(caseDetail.review_decision)}
          onComplete={onRefresh} />
        <AuditTimeline auditLogs={caseDetail.audit_logs} />
      </div>
    </div>
  );
}
