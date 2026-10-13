import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, HelpCircle, History, X } from 'lucide-react';
import type { CandidateDetail, CaseDetail, ReviewDecision } from '../../types';
import { Button } from '../ui/Button';
import { Field, Textarea } from '../ui/Field';
import { InlineFeedback, StatusIndicator } from '../ui/Feedback';
import { decisionLabel } from './casePresentation';
import './ReviewConsole.css';

interface ReviewConsoleProps {
  caseDetail: CaseDetail;
  activeCandidate: CandidateDetail | null;
  onSubmitDecision: (caseId: string, decision: ReviewDecision, candidateId?: string | null, notes?: string | null) => Promise<void>;
  isSubmitting: boolean;
  isReviewReady: boolean;
  compact?: boolean;
  readbackRequired?: boolean;
  onCheckSavedDecision?: () => void;
  onViewEvidence?: () => void;
  onChangeCandidate?: () => void;
  onViewHistory?: () => void;
}
type SubmittedDecision = Exclude<ReviewDecision, 'PENDING'>;
interface SubmissionIntent {
  caseNumber: string;
  decision: SubmittedDecision;
  candidateName: string | null;
  candidateId: string | null;
}
const actionLabel: Record<SubmittedDecision, string> = {
  ACCEPTED: 'Accept Candidate', REJECTED: 'Reject All', NEED_MORE_EVIDENCE: 'Need More Evidence',
};

export function ReviewConsole({ caseDetail, activeCandidate, onSubmitDecision, isSubmitting, isReviewReady,
  compact = false, readbackRequired = false, onCheckSavedDecision, onViewEvidence, onChangeCandidate, onViewHistory }: ReviewConsoleProps) {
  const [notes, setNotes] = useState(caseDetail.reviewer_notes || '');
  const [intent, setIntent] = useState<SubmissionIntent | null>(null);
  const submissionLocked = useRef(false);
  useEffect(() => { setNotes(caseDetail.reviewer_notes ?? ''); }, [caseDetail.id, caseDetail.reviewer_notes]);

  // Readiness and uncertain-write ownership stay in App. This local latch also
  // prevents repeated activation before the parent's loading render commits.
  const candidate = activeCandidate && caseDetail.candidates.some(item => item.id === activeCandidate.id) ? activeCandidate : null;
  const busy = isSubmitting || intent !== null;
  const serious = !!candidate && (candidate.has_serious_contradiction || candidate.contradictions.some(item => item.severity === 'SERIOUS'));
  const savedCandidate = caseDetail.candidates.find(item => item.id === caseDetail.selected_candidate_id);
  const reviewed = caseDetail.review_decision !== 'PENDING';
  const handleDecision = async (decision: SubmittedDecision) => {
    if (!isReviewReady || isSubmitting || submissionLocked.current || (decision === 'ACCEPTED' && !candidate)) return;
    submissionLocked.current = true;
    setIntent({ caseNumber: caseDetail.case_number, decision,
      candidateName: decision === 'ACCEPTED' ? candidate!.name : null, candidateId: decision === 'ACCEPTED' ? candidate!.id : null });
    try {
      await onSubmitDecision(caseDetail.id, decision, decision === 'ACCEPTED' ? candidate!.id : null, notes);
    } finally {
      submissionLocked.current = false;
      setIntent(null);
    }
    // Promise completion is not proof of a saved decision. Only authoritative
    // caseDetail readback below displays an outcome; App owns error/recovery.
  };
  const disabledDescription = busy ? 'review-progress' : !isReviewReady ? 'review-unavailable' : undefined;
  const conflictDescription = serious ? 'review-conflict-reminder' : undefined;
  // DOM order follows the visible mobile order, including keyboard navigation.
  const decisions: SubmittedDecision[] = serious && compact
    ? ['NEED_MORE_EVIDENCE', 'ACCEPTED', 'REJECTED'] : ['ACCEPTED', 'REJECTED', 'NEED_MORE_EVIDENCE'];

  return (
    <section className="case-review" aria-labelledby="case-review-heading">
      <header className="review-heading">
        <div>
          <h3 id="case-review-heading" tabIndex={-1}>Your review</h3>
          <p className="case-metadata">{caseDetail.case_number} · {caseDetail.raw_name}</p>
          <p>You make the final identity decision.</p>
        </div>
        {onViewHistory && <Button variant="quiet" onClick={onViewHistory} className="review-history-link">
          <History size={16} aria-hidden="true" />View Case history ({caseDetail.audit_logs.length})
        </Button>}
      </header>
      <div className="review-saved-decision">
        <div>
          <span className="review-label">{busy || readbackRequired ? 'Last loaded decision' : 'Saved decision'}</span>
          <StatusIndicator tone={caseDetail.review_decision === 'ACCEPTED' ? 'success' : caseDetail.review_decision === 'NEED_MORE_EVIDENCE' ? 'warning' : 'neutral'}>
            {decisionLabel[caseDetail.review_decision]}
          </StatusIndicator>
        </div>
        {reviewed && <p>You can update this decision using the options below.</p>}
        {caseDetail.review_decision === 'ACCEPTED' && <p>{busy || readbackRequired ? 'Last loaded candidate' : 'Saved candidate'}: {savedCandidate?.name || 'Accepted record unavailable'}</p>}
        {caseDetail.reviewed_at && <p className="case-metadata">Reviewed: {new Date(caseDetail.reviewed_at).toLocaleString()}</p>}
      </div>
      <div className="review-candidate-context">
        <div>
          <p className="review-label">Selected candidate for this review</p>
          {candidate ? <>
            <p className="review-candidate-name"><strong>{candidate.name}</strong></p>
            <p>{candidate.provider_source} · {candidate.provider_record_id}</p>
            <p className="case-metadata">{candidate.evidence.length} evidence fields · Evidence score: {candidate.total_score} / 100</p>
          </> : <p id="review-no-candidate">No valid candidate is selected for this Case. Accept requires a candidate record.</p>}
        </div>
        <div className="review-context-actions">
          {onChangeCandidate && caseDetail.candidates.length > 0 && <Button variant="quiet" onClick={onChangeCandidate}>Change candidate</Button>}
          {onViewEvidence && candidate && <Button variant="quiet" onClick={onViewEvidence}>Review field evidence</Button>}
        </div>
      </div>
      <p className="review-evidence-guidance">
        {candidate && !candidate.evidence.length ? 'Field evidence is unavailable for this candidate. Inspect the source record and available provenance before deciding.'
          : candidate && caseDetail.candidates[0]?.id !== candidate.id ? 'The Case recommendation describes the highest-ranked candidate. Inspect the selected candidate’s field evidence before deciding.'
          : 'Use the field evidence to decide which record, if any, belongs to this Case.'}
      </p>
      <Field id="reviewer-notes" label="Reviewer note (optional)" hint="Record what informed your decision. Optional; up to 2,000 characters."
        action={<span id="review-note-count" className="case-metadata">{notes.length} / 2000 chars</span>}>
        {accessibility => <Textarea {...accessibility} aria-describedby={`${accessibility['aria-describedby']} review-note-count`}
          rows={3} maxLength={2000} value={notes} onChange={event => setNotes(event.target.value)} placeholder="What evidence informed your decision?" />}
      </Field>
      {(serious || !!candidate?.contradictions.length) && <div id="review-conflict-reminder"
        className={`review-conflict-reminder ${serious ? 'review-conflict-serious' : 'review-conflict-moderate'}`} role="note">
        <AlertTriangle size={18} aria-hidden="true" />
        <div>
          <h4>{serious ? 'Serious conflict — review before deciding' : 'Evidence warnings to review'}</h4>
          <p>Selected candidate: {candidate!.name}</p>
          <ul>{candidate!.contradictions.map(item => <li key={item.id || item.contradiction_type}>{item.description}</li>)}</ul>
          {serious && !candidate!.contradictions.some(item => item.severity === 'SERIOUS') && <p>A serious conflict is reported, but its explanation is unavailable.</p>}
        </div>
      </div>}
      {!isReviewReady && <div className="review-unavailable">
        <p id="review-unavailable">{readbackRequired ? 'The saved decision is unconfirmed. Check this Case before submitting again.' : 'Review is currently unavailable for this Case.'}</p>
        {readbackRequired && onCheckSavedDecision && <Button onClick={onCheckSavedDecision} disabled={busy}>Check saved decision</Button>}
      </div>}
      <div className="review-actions">
        {decisions.map(decision => <Button key={decision}
          variant={decision === 'NEED_MORE_EVIDENCE' && serious ? 'primary' : 'secondary'}
          className={decision === 'ACCEPTED' ? 'review-accept' : decision === 'NEED_MORE_EVIDENCE' ? 'review-more-evidence' : undefined}
          onClick={() => void handleDecision(decision)} disabled={!isReviewReady || busy || (decision === 'ACCEPTED' && !candidate)}
          loading={intent?.decision === decision && (decision !== 'ACCEPTED' || intent.candidateId === candidate?.id)}
          aria-describedby={disabledDescription || (decision === 'ACCEPTED' && !candidate ? 'review-no-candidate' : conflictDescription)}>
          {decision === 'ACCEPTED' ? <Check size={16} aria-hidden="true" /> : decision === 'REJECTED' ? <X size={16} aria-hidden="true" /> : <HelpCircle size={16} aria-hidden="true" />}
          <span>{actionLabel[decision]}{decision === 'ACCEPTED' && candidate ? ` (${candidate.name})` : ''}</span>
        </Button>)}
      </div>
      <p className="review-action-help">Accept saves the selected candidate. Reject all records a rejection for this Case. Need more evidence records that further review is needed.</p>
      {busy && <InlineFeedback><span id="review-progress">{intent
        ? `Review submission in progress: ${actionLabel[intent.decision]} · ${intent.caseNumber}${intent.candidateName ? ` · ${intent.candidateName}` : ''}.`
        : 'A review request is in progress. Wait for it to finish before submitting.'}</span></InlineFeedback>}
    </section>
  );
}
