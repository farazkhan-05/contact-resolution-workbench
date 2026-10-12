import React, { useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { Job } from '../../types';
import { JobStatus } from '../jobs/JobStatus';
import { useJobStatus } from '../jobs/useJobStatus';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Field, Textarea } from '../ui/Field';
import { InlineFeedback } from '../ui/Feedback';
import '../ingestion/Ingestion.css';

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

  const activeJob = currentJob?.status === 'PENDING' || currentJob?.status === 'RUNNING';
  const jobDate = (value: string | null | undefined, missing: string) => value ? new Date(value).toLocaleString() : missing;
  return (
    <Dialog open={isOpen} onDismiss={onClose} dismissible={!isExtracting}
      labelledBy="ai-modal-title" describedBy="ai-modal-description" initialFocusRef={evidenceInput} className="ai-ingestion">
      <div className="ui-dialog-header">
        <div><p className="ingestion-eyebrow">Add records</p><h2 id="ai-modal-title" className="ui-dialog-title">AI evidence extraction</h2></div>
        <Button variant="quiet" iconOnly onClick={onClose} disabled={isExtracting} aria-label="Close dialog"><X size={18} aria-hidden="true" /></Button>
      </div>
      <div className="ui-dialog-body">
        <p id="ai-modal-description">AI extracts contact details from a source note. Extracted evidence is unverified; you make the final identity decision.</p>
        {!job ? <>
          <Field id="unstructured-evidence-input" label="Source note" hint="Include the contact details and any uncertainty in the original note." action={
            <Button variant="quiet" disabled={isExtracting} onClick={() => setEvidenceText(DEFAULT_SYNTHETIC_EVIDENCE)}>Reset to example</Button>
          }>{accessibility => <Textarea {...accessibility} ref={evidenceInput} rows={7} value={evidenceText}
            onChange={(e) => setEvidenceText(e.target.value)} disabled={isExtracting || job !== null}
            aria-invalid={error && !submissionUnknown ? true : undefined}
            aria-errormessage={error && !submissionUnknown ? 'ai-submission-feedback' : undefined}
            placeholder="Paste a synthetic source note, call transcript or directory snippet." />}</Field>
          <p className="ingestion-muted">Demo only — use synthetic information. Do not enter real personal data.</p>
          {isExtracting && <InlineFeedback>Submitting your note. Waiting for confirmation; extraction is not yet confirmed.</InlineFeedback>}
          {error && <div id="ai-submission-feedback"><InlineFeedback tone="error">
            <p className="ingestion-feedback-title">{submissionUnknown ? 'Submission outcome unknown' : 'Input was not accepted'}</p><p>{error}</p>
          </InlineFeedback></div>}
          {submissionUnknown && <p className="ingestion-muted">An unknown outcome is not a confirmed failure. Close this dialog to check Recent activity. Another extraction is blocked in this view.</p>}
        </> : currentJob ? <section className="ai-job-result" aria-label="Extraction Job result">
          <h3>{activeJob ? 'Extraction accepted' : 'Extraction result'}</h3>
          {activeJob && <p className="ingestion-muted">The Job was accepted. Wait for its result before reviewing the extracted evidence.</p>}
          <div className="ai-job-status"><JobStatus job={currentJob} error={tracking.error} checking={tracking.checking} onCheck={tracking.checkAgain} /></div>
          <dl className="ingestion-job-facts">
            <div><dt>Job reference</dt><dd>{currentJob.id}</dd></div>
            <div><dt>Created</dt><dd>{jobDate(currentJob.created_at, 'Unavailable')}</dd></div>
            <div><dt>Started</dt><dd>{jobDate(currentJob.started_at, 'Not started')}</dd></div>
            {currentJob.completed_at && <div><dt>Completed</dt><dd>{jobDate(currentJob.completed_at, 'Not completed')}</dd></div>}
          </dl>
          {typeof currentJob.processed_rows === 'number' && typeof currentJob.total_rows === 'number' && <p className="ingestion-muted">{tracking.error ? 'Last reported records' : 'Records processed'}: {currentJob.processed_rows} of {currentJob.total_rows}.
            {currentJob.rejected_rows > 0 && <> Rejected: {currentJob.rejected_rows}.</>}</p>}
          {tracking.error && <p className="ingestion-muted">Check again reads this Job's status. It does not submit another extraction.</p>}
          {currentJob.status === 'FAILED' && !tracking.error && <p className="ingestion-muted">Try again returns to your note. Edit it before explicitly submitting a new attempt.</p>}
          {currentJob.status === 'SUCCEEDED' && !refreshError && <p className="ingestion-muted">Close this dialog to return to Cases and review the available evidence. Extracted evidence still needs human verification.</p>}
          <p className="ingestion-muted">Closing this dialog does not cancel accepted work. You can also check its status in Recent activity.</p>
        </section> : null}
        {refreshError && <InlineFeedback tone="error">Extraction completed. Could not refresh cases. Close this dialog and refresh cases.</InlineFeedback>}
      </div>
      <div className="ui-dialog-footer">
        {!job ? <>
          <Button onClick={onClose} disabled={isExtracting}>Cancel</Button>
          <Button variant="primary" loading={isExtracting} onClick={handleExtractAndResolve} disabled={isExtracting || submissionUnknown || !evidenceText.trim()}>
            {isExtracting ? 'Submitting\u2026' : 'Extract evidence'}
          </Button>
        </> : <>
          {currentJob?.status === 'FAILED' && !tracking.error && <Button onClick={() => {
            ++generation.current;
            setJob(null); setError(null); setRefreshError(false); notified.current = null;
          }}>Try again</Button>}
          <Button onClick={onClose}>Close</Button>
        </>}
      </div>
    </Dialog>
  );
};
