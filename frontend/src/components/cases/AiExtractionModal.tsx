import React, { useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Bot,
  CheckCircle2,
  Info,
  Loader2,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { UnstructuredIngestResponse } from '../../types';

interface AiExtractionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCaseCreated: (caseId: string) => Promise<void>;
}

const DEFAULT_SYNTHETIC_EVIDENCE =
  'Spoke with Claire Reynolds — now at Northstar Analytics as Senior Data Analyst in Seattle. Best email appears to be claire.reynolds@example.demo; mobile +1 202-555-0101.';

export const AiExtractionModal: React.FC<AiExtractionModalProps> = ({
  isOpen,
  onClose,
  onCaseCreated,
}) => {
  const [evidenceText, setEvidenceText] = useState(DEFAULT_SYNTHETIC_EVIDENCE);
  const [isExtracting, setIsExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UnstructuredIngestResponse | null>(null);

  if (!isOpen) return null;

  const handleExtractAndResolve = async () => {
    if (!evidenceText.trim() || isExtracting) return;
    setIsExtracting(true);
    setError(null);

    // Generate a compact, collision-safe demo case number without extra dependencies
    const uniqueDemoCaseNumber =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `AI-DEMO-${crypto.randomUUID().slice(0, 8)}`
        : `AI-DEMO-${Math.random().toString(36).substring(2, 10)}`;

    try {
      const response = await api.ingestUnstructured({
        case_number: uniqueDemoCaseNumber,
        raw_evidence_text: evidenceText.trim(),
        source_identifier: 'GEMINI_EXTRACTION_DEMO',
      });
      setResult(response);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.detail
          : 'Extraction request failed. Check server logs or connectivity and retry.';
      setError(message);
    } finally {
      setIsExtracting(false);
    }
  };

  const handleOpenCase = async () => {
    if (result) {
      const caseIdToOpen = result.case_id;
      onClose();
      await onCaseCreated(caseIdToOpen);
    }
  };

  const handleResetForm = () => {
    setResult(null);
    setError(null);
    setEvidenceText(DEFAULT_SYNTHETIC_EVIDENCE);
  };

  const getRoutingBadgeClass = (status: string) => {
    switch (status) {
      case 'LIKELY_MATCH':
        return 'bg-emerald-50 text-emerald-800 border-emerald-200';
      case 'NEEDS_REVIEW':
        return 'bg-amber-50 text-amber-800 border-amber-200';
      default:
        return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  const getRoutingLabel = (status: string) => {
    switch (status) {
      case 'LIKELY_MATCH':
        return 'Likely Match';
      case 'NEEDS_REVIEW':
        return 'Needs Review';
      case 'NO_RELIABLE_MATCH':
        return 'No Match';
      default:
        return status;
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-modal-title"
    >
      <div className="flex w-full max-w-xl flex-col rounded-lg border border-border bg-surface shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5 bg-surface-muted/60">
          <div className="flex items-center space-x-2">
            <div className="flex h-7 w-7 items-center justify-center rounded bg-accent-muted text-accent">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <h2 id="ai-modal-title" className="text-sm font-bold text-foreground">
                Try AI Evidence Extraction
              </h2>
              <span className="text-[11px] text-muted">Powered by gemini-3.1-flash-lite</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isExtracting}
            className="rounded p-1 text-muted hover:bg-surface hover:text-foreground disabled:opacity-50"
            aria-label="Close dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 space-y-4 max-h-[80vh] overflow-y-auto">
          {!result ? (
            <>
              <p className="text-xs text-foreground leading-relaxed">
                Paste a messy synthetic provider note. Gemini extracts structured contact
                evidence, then the existing deterministic matcher evaluates the candidate.
              </p>

              {/* Textarea Input */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="unstructured-evidence-input"
                    className="text-[11px] font-semibold uppercase tracking-wider text-muted"
                  >
                    Unstructured Provider Evidence
                  </label>
                  <button
                    type="button"
                    onClick={() => setEvidenceText(DEFAULT_SYNTHETIC_EVIDENCE)}
                    className="text-[11px] text-accent hover:underline"
                  >
                    Reset to example
                  </button>
                </div>
                <textarea
                  id="unstructured-evidence-input"
                  rows={4}
                  value={evidenceText}
                  onChange={(e) => setEvidenceText(e.target.value)}
                  disabled={isExtracting}
                  placeholder="Paste unstructured synthetic notes, call transcripts, or directory snippets..."
                  className="w-full rounded border border-border bg-background p-3 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-60"
                />
              </div>

              {/* Privacy Note */}
              <div className="flex items-center space-x-2 rounded border border-border bg-surface-muted/40 px-3 py-2 text-[11px] text-muted">
                <Info className="h-3.5 w-3.5 shrink-0 text-muted" />
                <span>Demo only — use synthetic information. Do not enter real personal data.</span>
              </div>

              {/* Error Feedback */}
              {error && (
                <div
                  className="flex items-start space-x-2 rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900"
                  role="alert"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 text-rose-600 mt-0.5" />
                  <div className="flex-1">
                    <p className="font-semibold">Extraction Failed</p>
                    <p className="mt-0.5 text-[11px] text-rose-800">{error}</p>
                  </div>
                </div>
              )}
            </>
          ) : (
            /* Success State */
            <div className="space-y-4">
              <div className="flex items-center space-x-2 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded p-2.5">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                <span>AI Extraction Complete ({result.case_number})</span>
              </div>

              {/* Extracted Fields Matrix */}
              <div className="rounded border border-border bg-surface p-3.5 space-y-2.5">
                <div className="flex items-center justify-between border-b border-border pb-2">
                  <div className="flex items-center space-x-1.5 text-xs font-semibold text-foreground">
                    <Bot className="h-3.5 w-3.5 text-accent" />
                    <span>Gemini Structured Output</span>
                  </div>
                  <span className="text-[10px] text-muted font-mono">Pydantic Validated</span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded bg-surface-muted/50 p-2 border border-border/50">
                    <span className="text-[10px] font-medium text-muted block">Name</span>
                    <span className="font-semibold text-foreground">
                      {result.extracted_profile.name || (
                        <span className="text-muted italic">Null</span>
                      )}
                    </span>
                  </div>
                  <div className="rounded bg-surface-muted/50 p-2 border border-border/50">
                    <span className="text-[10px] font-medium text-muted block">Email</span>
                    <span className="text-foreground">
                      {result.extracted_profile.email || (
                        <span className="text-muted italic">Null</span>
                      )}
                    </span>
                  </div>
                  <div className="rounded bg-surface-muted/50 p-2 border border-border/50">
                    <span className="text-[10px] font-medium text-muted block">Phone</span>
                    <span className="text-foreground">
                      {result.extracted_profile.phone || (
                        <span className="text-muted italic">Null</span>
                      )}
                    </span>
                  </div>
                  <div className="rounded bg-surface-muted/50 p-2 border border-border/50">
                    <span className="text-[10px] font-medium text-muted block">Employer</span>
                    <span className="text-foreground">
                      {result.extracted_profile.employer || (
                        <span className="text-muted italic">Null</span>
                      )}
                    </span>
                  </div>
                  <div className="rounded bg-surface-muted/50 p-2 border border-border/50">
                    <span className="text-[10px] font-medium text-muted block">Job Title</span>
                    <span className="text-foreground">
                      {result.extracted_profile.job_title || (
                        <span className="text-muted italic">Null</span>
                      )}
                    </span>
                  </div>
                  <div className="rounded bg-surface-muted/50 p-2 border border-border/50">
                    <span className="text-[10px] font-medium text-muted block">Location</span>
                    <span className="text-foreground">
                      {result.extracted_profile.location || (
                        <span className="text-muted italic">Null</span>
                      )}
                    </span>
                  </div>
                </div>
              </div>

              {/* Deterministic Evaluation Output */}
              <div className="flex items-center justify-between rounded border border-border bg-surface-muted p-3">
                <div>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted block">
                    Evidence Score
                  </span>
                  <span className="font-mono text-sm font-bold text-foreground">
                    {result.top_score} <span className="text-xs font-normal text-muted">/ 100</span>
                  </span>
                </div>
                <div>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted block">
                    Routing Status
                  </span>
                  <span
                    className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${getRoutingBadgeClass(
                      result.routing_status
                    )}`}
                  >
                    {getRoutingLabel(result.routing_status)}
                  </span>
                </div>
                <div>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted block">
                    Candidates
                  </span>
                  <span className="text-xs font-semibold text-foreground">
                    {result.candidate_count} evaluated
                  </span>
                </div>
              </div>

              {/* Explicit Distinction Note */}
              <div className="rounded border border-border bg-surface px-3 py-2 text-[11px] text-muted">
                <p>
                  <strong className="text-foreground">Architecture distinction:</strong> Gemini
                  extracted the structured evidence. The evidence score and routing were calculated
                  by deterministic matching rules.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer Actions */}
        <div className="flex items-center justify-between border-t border-border bg-surface-muted/40 px-5 py-3">
          {!result ? (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={isExtracting}
                className="rounded border border-border bg-surface px-3.5 py-1.5 text-xs font-medium text-foreground hover:bg-surface-muted disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleExtractAndResolve}
                disabled={isExtracting || !evidenceText.trim()}
                className="inline-flex items-center space-x-1.5 rounded bg-accent px-4 py-1.5 text-xs font-medium text-accent-contrast shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isExtracting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Extracting…</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>Extract & Resolve</span>
                  </>
                )}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={handleResetForm}
                className="inline-flex items-center space-x-1 rounded border border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground"
              >
                <RotateCcw className="h-3 w-3" />
                <span>Extract Another</span>
              </button>
              <button
                type="button"
                onClick={handleOpenCase}
                className="inline-flex items-center space-x-1.5 rounded bg-accent px-4 py-1.5 text-xs font-medium text-accent-contrast shadow-sm hover:opacity-90"
              >
                <span>Open Case in Workbench</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
