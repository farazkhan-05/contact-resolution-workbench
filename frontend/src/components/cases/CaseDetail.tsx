import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle,
  HelpCircle,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import type { CandidateDetail, CaseDetail as CaseDetailType, ReviewDecision } from '../../types';
import { AuditTimeline } from './AuditTimeline';
import { CandidateList } from './CandidateList';
import { ContradictionAlert } from './ContradictionAlert';
import { EvidenceMatrix } from './EvidenceMatrix';
import { OriginalRecord } from './OriginalRecord';
import { ReviewConsole } from './ReviewConsole';
import { InvestigationPanel } from './InvestigationPanel';

interface CaseDetailProps {
  caseDetail: CaseDetailType | null;
  isLoading: boolean;
  onBackMobile: () => void;
  onSubmitDecision: (decision: ReviewDecision, candidateId?: string | null, notes?: string | null) => Promise<void>;
  isSubmittingDecision: boolean;
  onRefresh: () => void;
}

export const CaseDetail: React.FC<CaseDetailProps> = ({
  caseDetail,
  isLoading,
  onBackMobile,
  onSubmitDecision,
  isSubmittingDecision,
  onRefresh,
}) => {
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);

  useEffect(() => {
    if (caseDetail && caseDetail.candidates.length > 0) {
      // Default to selected candidate if accepted, otherwise top-ranked candidate
      if (caseDetail.selected_candidate_id) {
        setSelectedCandidateId(caseDetail.selected_candidate_id);
      } else {
        setSelectedCandidateId(caseDetail.candidates[0].id);
      }
    } else {
      setSelectedCandidateId(null);
    }
  }, [caseDetail]);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-xs text-muted">
        Loading case details...
      </div>
    );
  }

  if (!caseDetail) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center">
        <div className="max-w-sm space-y-2">
          <p className="text-sm font-semibold text-foreground">Select a case to inspect</p>
          <p className="text-xs text-muted leading-relaxed">
            Choose a case from the queue on the left to review original attributes, matching evidence, and record human decisions.
          </p>
        </div>
      </div>
    );
  }

  const activeCandidate: CandidateDetail | null =
    caseDetail.candidates.find((c) => c.id === selectedCandidateId) ||
    (caseDetail.candidates.length > 0 ? caseDetail.candidates[0] : null);

  const isLikelyMatch = caseDetail.routing_status === 'LIKELY_MATCH';
  const isNeedsReview = caseDetail.routing_status === 'NEEDS_REVIEW';

  return (
    <div className="flex-1 overflow-y-auto bg-background p-4 sm:p-6 space-y-5 case-detail-content">
      {/* Mobile Back Button */}
      <button
        type="button"
        onClick={onBackMobile}
        className="inline-flex items-center space-x-1.5 text-xs font-medium text-muted hover:text-foreground md:hidden"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        <span>Back to case queue</span>
      </button>

      {caseDetail.ingestion_id && <div className="rounded border border-border bg-surface p-3 text-xs"><p>Source: {caseDetail.source_identifier}</p><p>Ingestion: API ? {caseDetail.ingestion_id}</p><p>External record: {caseDetail.external_record_id}</p><p>Received: {new Date(caseDetail.received_at || caseDetail.created_at).toLocaleString()}</p></div>}
      {/* Case Header Card */}
      <div className="rounded border border-border bg-surface p-4 sm:p-5">
        <div className="case-header-content flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center space-x-2.5">
              <span className="font-mono text-xs font-bold text-muted bg-surface-muted px-2 py-0.5 rounded border border-border">
                {caseDetail.case_number}
              </span>
              <h2 className="text-lg font-bold tracking-tight text-foreground">
                {caseDetail.raw_name}
              </h2>
            </div>
            <p className="text-xs text-muted">
              Created: {new Date(caseDetail.received_at || caseDetail.created_at).toLocaleString()}
            </p>
          </div>

          {/* Status Indicators */}
          <div className="flex flex-wrap items-center gap-2">
            {/* System Routing Badge */}
            <div
              className={`inline-flex items-center space-x-1.5 rounded px-2.5 py-1 text-xs font-medium ${
                isLikelyMatch
                  ? 'border border-emerald-300 bg-emerald-50 text-emerald-900'
                  : isNeedsReview
                  ? 'border border-amber-300 bg-amber-50 text-amber-900'
                  : 'border border-slate-300 bg-slate-100 text-slate-900'
              }`}
            >
              {isLikelyMatch && <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />}
              {isNeedsReview && <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />}
              <span>System: {caseDetail.routing_status.replace('_', ' ')}</span>
            </div>

            {/* Reviewer Decision Badge */}
            <div className="inline-flex items-center space-x-1.5 rounded border border-border bg-surface-muted px-2.5 py-1 text-xs font-semibold text-foreground">
              {caseDetail.review_decision === 'ACCEPTED' && (
                <CheckCircle className="h-3.5 w-3.5 text-emerald-600" />
              )}
              {caseDetail.review_decision === 'REJECTED' && (
                <XCircle className="h-3.5 w-3.5 text-rose-600" />
              )}
              {caseDetail.review_decision === 'NEED_MORE_EVIDENCE' && (
                <HelpCircle className="h-3.5 w-3.5 text-amber-600" />
              )}
              <span>Decision: {caseDetail.review_decision.replace('_', ' ')}</span>
            </div>
          </div>
        </div>

        {/* Routing Explanation Banner */}
        <div className="mt-3.5 rounded bg-surface-muted/80 px-3 py-2 text-xs text-slate-700 flex items-start space-x-2">
          <span className="font-semibold text-foreground shrink-0">Routing Explanation:</span>
          <span>{caseDetail.routing_explanation}</span>
        </div>
      </div>

      {/* 1. Original Record Panel */}
      <OriginalRecord caseDetail={caseDetail} />
      <InvestigationPanel key={caseDetail.id} caseId={caseDetail.id}
        eligible={isNeedsReview && ['PENDING', 'NEED_MORE_EVIDENCE'].includes(caseDetail.review_decision)}
        onComplete={onRefresh} />

      {/* 2. Candidate Match Selector */}
      <CandidateList
        candidates={caseDetail.candidates}
        selectedCandidateId={selectedCandidateId}
        onSelectCandidate={setSelectedCandidateId}
      />

      {/* 3. Contradiction Callout if active candidate has contradictions */}
      {activeCandidate && (
        <ContradictionAlert contradictions={activeCandidate.contradictions} />
      )}

      {/* 4. Evidence Matrix Comparison */}
      {activeCandidate && (
        <EvidenceMatrix
          activeCandidate={activeCandidate}
        />
      )}

      {/* 5. Reviewer Decision Console */}
      <ReviewConsole
        caseDetail={caseDetail}
        activeCandidate={activeCandidate}
        onSubmitDecision={onSubmitDecision}
        isSubmitting={isSubmittingDecision}
      />

      {/* 6. Audit Trail */}
      <AuditTimeline auditLogs={caseDetail.audit_logs} />
    </div>
  );
};
