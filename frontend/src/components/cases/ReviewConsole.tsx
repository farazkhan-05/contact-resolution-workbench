import React, { useEffect, useState } from 'react';
import {
  Check,
  CheckCircle2,
  HelpCircle,
  Loader2,
  RotateCcw,
  X,
  XCircle,
} from 'lucide-react';
import type { CandidateDetail, CaseDetail, ReviewDecision } from '../../types';

interface ReviewConsoleProps {
  caseDetail: CaseDetail;
  activeCandidate: CandidateDetail | null;
  onSubmitDecision: (decision: ReviewDecision, candidateId?: string | null, notes?: string | null) => Promise<void>;
  isSubmitting: boolean;
}

export const ReviewConsole: React.FC<ReviewConsoleProps> = ({
  caseDetail,
  activeCandidate,
  onSubmitDecision,
  isSubmitting,
}) => {
  const [notes, setNotes] = useState(caseDetail.reviewer_notes || '');

  useEffect(() => {
    setNotes(caseDetail.reviewer_notes ?? '');
  }, [caseDetail.id, caseDetail.reviewer_notes]);

  const handleDecision = async (decision: ReviewDecision) => {
    const candidateId = decision === 'ACCEPTED' ? activeCandidate?.id : null;
    await onSubmitDecision(decision, candidateId, notes);
  };

  const isCurrentAccepted = caseDetail.review_decision === 'ACCEPTED';
  const isCurrentRejected = caseDetail.review_decision === 'REJECTED';
  const isCurrentNeedMore = caseDetail.review_decision === 'NEED_MORE_EVIDENCE';
  const isReviewed = caseDetail.review_decision !== 'PENDING';

  return (
    <div className="rounded border border-border bg-surface p-4 space-y-3.5">
      <div className="flex items-center justify-between pb-2.5 border-b border-border">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
          Reviewer Decision Console
        </h3>
        {isReviewed && (
          <span className="text-[11px] text-muted flex items-center space-x-1">
            <RotateCcw className="h-3 w-3" />
            <span>Revision mode: you can update previous decision below</span>
          </span>
        )}
      </div>

      {/* Current Decision Status Banner if already decided */}
      {isReviewed && (
        <div
          className={`rounded border p-2.5 text-xs flex items-center justify-between ${
            isCurrentAccepted
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : isCurrentRejected
              ? 'border-rose-200 bg-rose-50 text-rose-900'
              : 'border-amber-200 bg-amber-50 text-amber-900'
          }`}
        >
          <div className="flex items-center space-x-2">
            {isCurrentAccepted && <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />}
            {isCurrentRejected && <XCircle className="h-4 w-4 text-rose-600 shrink-0" />}
            {isCurrentNeedMore && <HelpCircle className="h-4 w-4 text-amber-600 shrink-0" />}
            <span className="font-semibold">
              Current Verdict: {caseDetail.review_decision}
              {caseDetail.selected_candidate_id && ' (Candidate Accepted)'}
            </span>
          </div>
          {caseDetail.reviewed_at && (
            <span className="text-[10px] text-slate-500 font-mono">
              Reviewed: {new Date(caseDetail.reviewed_at).toLocaleTimeString()}
            </span>
          )}
        </div>
      )}

      {/* Plain Text Notes Area */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-muted">
          <label htmlFor="reviewer-notes" className="font-medium text-foreground">
            Reviewer Operational Note (Optional)
          </label>
          <span>{notes.length} / 2000 chars</span>
        </div>
        <textarea
          id="reviewer-notes"
          rows={2}
          value={notes}
          maxLength={2000}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. Verified alumni registry email alias matches subject profile..."
          className="w-full rounded border border-border bg-background p-2 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
        />
      </div>

      {/* Serious Contradiction Decision Guardrail */}
      {activeCandidate?.has_serious_contradiction && (
        <div className="rounded border border-rose-200 bg-rose-50/70 p-2 text-xs text-rose-900 flex items-center space-x-2">
          <span className="font-bold text-[10px] bg-rose-200 text-rose-800 px-1 py-0.5 rounded uppercase">Guardrail</span>
          <span className="text-[11px]">Active candidate has a serious contradiction. Accepting requires manual verification.</span>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex flex-col sm:flex-row gap-2 pt-1">
        <button
          type="button"
          onClick={() => handleDecision('ACCEPTED')}
          disabled={isSubmitting || !activeCandidate}
          className="flex-1 inline-flex items-center justify-center space-x-1.5 rounded bg-accent px-4 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          <span>
            Accept Candidate {activeCandidate ? `(${activeCandidate.name})` : ''}
          </span>
        </button>

        <button
          type="button"
          onClick={() => handleDecision('REJECTED')}
          disabled={isSubmitting}
          className="inline-flex items-center justify-center space-x-1.5 rounded border border-rose-200 bg-surface px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
          <span>Reject All</span>
        </button>

        <button
          type="button"
          onClick={() => handleDecision('NEED_MORE_EVIDENCE')}
          disabled={isSubmitting}
          className="inline-flex items-center justify-center space-x-1.5 rounded border border-amber-200 bg-surface px-3 py-2 text-xs font-semibold text-amber-700 hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <HelpCircle className="h-3.5 w-3.5" />
          <span>Need More Evidence</span>
        </button>
      </div>
    </div>
  );
};
