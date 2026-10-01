import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Info,
  Loader2,
  Sparkles,
  X,
} from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { Job } from '../../types';

interface AiExtractionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCaseCreated: (caseNumber: string) => Promise<void>;
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
  const [job, setJob] = useState<Job | null>(null);
  const [caseNumber, setCaseNumber] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

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
      const createdCaseNumber = uniqueDemoCaseNumber;
      const submitted = await api.ingestUnstructured({
        case_number: uniqueDemoCaseNumber,
        raw_evidence_text: evidenceText.trim(),
        source_identifier: 'GEMINI_EXTRACTION_DEMO',
      });
      setCaseNumber(createdCaseNumber);
      setJob(submitted);
      const poll = async (): Promise<void> => {
        try {
          const current = await api.getJob(submitted.id);
          if (!active.current) return;
          setJob(current);
          if (current.status === 'SUCCEEDED') {
            await onCaseCreated(createdCaseNumber);
            onClose();
          } else if (current.status !== 'FAILED') {
            timer.current = window.setTimeout(() => void poll(), 1800);
          }
        } catch {
          if (active.current) setError('Could not check extraction status. The Job remains available in this workspace.');
        }
      };
      timer.current = window.setTimeout(() => void poll(), 1000);
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
            {!job ? (
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
                  disabled={isExtracting || job !== null}
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
                    <p className="font-semibold">Status check failed</p>
                    <p className="mt-0.5 text-[11px] text-rose-800">{error}</p>
                  </div>
                </div>
              )}
            </>
          ) : job ? (
            <div className={`flex items-start space-x-2 rounded border p-3 text-xs ${job.status === 'FAILED' ? 'border-rose-200 bg-rose-50 text-rose-900' : 'border-blue-200 bg-blue-50 text-blue-900'}`} role="status">
              {job.status === 'FAILED' ? <AlertCircle className="h-4 w-4 shrink-0" /> : <Loader2 className="h-4 w-4 shrink-0 animate-spin" />}
              <div><p className="font-semibold">Gemini ingestion {job.status.toLowerCase()}</p><p className="mt-0.5 text-[11px]">{job.failure_message || (caseNumber ? `Case ${caseNumber}` : 'Processing structured evidence and deterministic resolution.')}</p></div>
            </div>
          ) : null}
        </div>

        {/* Modal Footer Actions */}
        <div className="flex items-center justify-between border-t border-border bg-surface-muted/40 px-5 py-3">
          {!job ? (
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
              <button type="button" onClick={onClose} className="rounded border border-border bg-surface px-3.5 py-1.5 text-xs font-medium text-foreground hover:bg-surface-muted">Close</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
