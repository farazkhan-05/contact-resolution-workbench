import React, { useLayoutEffect, useRef, useState } from 'react';
import {
  Info,
  Sparkles,
  X,
} from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { Job } from '../../types';
import { JobStatus } from '../jobs/JobStatus';
import { useJobStatus } from '../jobs/useJobStatus';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Field, Textarea } from '../ui/Field';
import { InlineFeedback } from '../ui/Feedback';

interface AiExtractionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCaseCreated: (caseNumber: string, canApply: () => boolean) => Promise<void>;
  onJobAccepted?: () => void;
}

const DEFAULT_SYNTHETIC_EVIDENCE =
  'Spoke with Claire Reynolds — now at Northstar Analytics as Senior Data Analyst in Seattle. Best email appears to be claire.reynolds@example.demo; mobile +1 202-555-0101.';

export const AiExtractionModal: React.FC<AiExtractionModalProps> = ({
  isOpen,
  onClose,
  onCaseCreated,
  onJobAccepted,
}) => {
  const [evidenceText, setEvidenceText] = useState(DEFAULT_SYNTHETIC_EVIDENCE);
  const [isExtracting, setIsExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [submissionUnknown, setSubmissionUnknown] = useState(false);
  const [caseNumber, setCaseNumber] = useState('');
  const [refreshError, setRefreshError] = useState(false);
  const tracking = useJobStatus(job, isOpen);
  const currentJob = tracking.job;
  const generation = useRef(0);
  const evidenceInput = useRef<HTMLTextAreaElement>(null);
  const notified = useRef<string | null>(null);
  const callback = useRef(onCaseCreated);
  callback.current = onCaseCreated;
  useLayoutEffect(() => {
    const lifecycle = generation;
    ++lifecycle.current;
    if (!isOpen) return;
    return () => {
      ++lifecycle.current;
    };
  }, [isOpen]);
  useLayoutEffect(() => {
    if (!isOpen || currentJob?.status !== 'SUCCEEDED' || notified.current === currentJob.id) return;
    notified.current = currentJob.id;
    const owner = generation.current;
    void callback.current(caseNumber, () => generation.current === owner).catch(() => {
      if (generation.current === owner) setRefreshError(true);
    });
  }, [isOpen, currentJob, caseNumber]);

  if (!isOpen) return null;

  const handleExtractAndResolve = async () => {
    if (!evidenceText.trim() || isExtracting || job || submissionUnknown) return;
    const owner = generation.current;
    setIsExtracting(true);
    setError(null);

    // Generate a compact, collision-safe demo case number without extra dependencies
    const uniqueDemoCaseNumber =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `AI-DEMO-${crypto.randomUUID().slice(0, 8)}`
        : `AI-DEMO-${Math.random().toString(36).substring(2, 10)}`;

    try {
      const submitted = await api.ingestUnstructured({
        case_number: uniqueDemoCaseNumber,
        raw_evidence_text: evidenceText.trim(),
        source_identifier: 'GEMINI_EXTRACTION_DEMO',
      });
      if (generation.current !== owner) return;
      setCaseNumber(uniqueDemoCaseNumber);
      setJob(submitted);
      onJobAccepted?.();
    } catch (err) {
      if (generation.current !== owner) return;
      const rejected = err instanceof ApiError && [400, 413, 422].includes(err.status);
      setSubmissionUnknown(!rejected);
      setError(rejected ? 'Could not extract evidence. Check your input.' : 'We could not confirm whether the extraction was accepted. Check Recent activity before starting another attempt.');
      onJobAccepted?.();
    } finally {
      if (generation.current === owner) setIsExtracting(false);
    }
  };

  return (
    <Dialog open={isOpen} onDismiss={onClose} dismissible={!isExtracting}
      labelledBy="ai-modal-title" describedBy="ai-modal-description" initialFocusRef={evidenceInput}>
        {/* Modal Header */}
        <div className="ui-dialog-header">
          <div className="flex items-center space-x-2">
            <div className="flex h-7 w-7 items-center justify-center rounded bg-accent-muted text-accent">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <h2 id="ai-modal-title" className="ui-dialog-title">
                Try AI Evidence Extraction
              </h2>
              <span className="text-xs text-muted">Powered by gemini-3.1-flash-lite</span>
            </div>
          </div>
          <Button variant="quiet" iconOnly
            onClick={onClose}
            disabled={isExtracting}
            aria-label="Close dialog"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Modal Body */}
        <div className="ui-dialog-body">
          <p id="ai-modal-description">Paste a synthetic source note. AI extracts contact evidence; matching uses points. You make the final identity decision.</p>
            {!job ? (
            <>
              {/* Textarea Input */}
              <Field id="unstructured-evidence-input" label="Unstructured Provider Evidence" action={
                  <Button variant="quiet"
                    onClick={() => setEvidenceText(DEFAULT_SYNTHETIC_EVIDENCE)}
                  >
                    Reset to example
                  </Button>
                }>{accessibility => <Textarea {...accessibility} ref={evidenceInput}
                  rows={4}
                  value={evidenceText}
                  onChange={(e) => setEvidenceText(e.target.value)}
                  disabled={isExtracting || job !== null}
                  placeholder="Paste unstructured synthetic notes, call transcripts, or directory snippets..."
                />}</Field>

              {/* Privacy Note */}
              <div className="flex items-center space-x-2 text-sm text-muted">
                <Info className="h-3.5 w-3.5 shrink-0 text-muted" />
                <span>Demo only — use synthetic information. Do not enter real personal data.</span>
              </div>

              {/* Error Feedback */}
              {error && (
                <InlineFeedback tone="error">
                    <p className="font-semibold">Could not start extraction</p>
                    <p>{error}</p>
                </InlineFeedback>
              )}
            </>
          ) : currentJob ? (
            <JobStatus job={currentJob} error={tracking.error} checking={tracking.checking} onCheck={tracking.checkAgain} />
          ) : null}
          {refreshError && <InlineFeedback tone="error">Extraction completed. Could not refresh cases. Close this dialog and refresh cases.</InlineFeedback>}
        </div>

        {/* Modal Footer Actions */}
        <div className="ui-dialog-footer">
          {!job ? (
            <>
              <Button
                onClick={onClose}
                disabled={isExtracting}
              >
                Cancel
              </Button>
              <Button variant="primary" loading={isExtracting}
                onClick={handleExtractAndResolve}
                disabled={isExtracting || submissionUnknown || !evidenceText.trim()}
              >
                {isExtracting ? (
                  <>
                    <span>Extracting…</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>Extract & Resolve</span>
                  </>
                )}
              </Button>
            </>
          ) : (
            <>
              {currentJob?.status === 'FAILED' && !tracking.error && <Button onClick={() => {
                ++generation.current;
                setJob(null); setError(null); setRefreshError(false); notified.current = null;
              }}>Try again</Button>}
              <Button onClick={onClose}>Close</Button>
            </>
          )}
        </div>
    </Dialog>
  );
};
