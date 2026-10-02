import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api/client';
import { Sources } from './components/Sources';
import { AuthScreen } from './auth/AuthScreen';
import { useAuth } from './auth/AuthProvider';
import { recordUsageEvent } from './api/telemetry';
import { AppShell } from './components/layout/AppShell';
import { AiExtractionModal } from './components/cases/AiExtractionModal';
import { CaseDetail } from './components/cases/CaseDetail';
import { CaseQueue } from './components/cases/CaseQueue';
import type {
  CaseDetail as CaseDetailType,
  CaseSummary,
  ReviewDecision,
  RoutingStatus,
} from './types';

export function App() {
  const { status, workspace, signOutUser } = useAuth();
  const [page, setPage] = useState<'cases' | 'sources'>('cases');
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [hasUnfilteredQueue, setHasUnfilteredQueue] = useState(false);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [selectedCaseDetail, setSelectedCaseDetail] = useState<CaseDetailType | null>(null);

  const [activeRoutingFilter, setActiveRoutingFilter] = useState<RoutingStatus | 'ALL'>('ALL');
  const [activeDecisionFilter, setActiveDecisionFilter] = useState<ReviewDecision | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  const [isLoadingQueue, setIsLoadingQueue] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isLoadingSample, setIsLoadingSample] = useState(false);
  const [isUploadingCsv, setIsUploadingCsv] = useState(false);
  const [isExportingCsv, setIsExportingCsv] = useState(false);
  const [isSubmittingDecision, setIsSubmittingDecision] = useState(false);
  const [isAiModalOpen, setIsAiModalOpen] = useState(false);

  const [mobileView, setMobileView] = useState<'queue' | 'detail'>('queue');
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error' | 'info';
    message: string;
  } | null>(null);

  const hasTrackedAppOpen = useRef(false);
  const lastViewedCaseRef = useRef<string | null>(null);
  const jobPollTimers = useRef(new Set<number>());
  const pollingSessionActive = useRef(status === 'ready');

  const clearJobPollTimers = () => {
    jobPollTimers.current.forEach((timer) => window.clearTimeout(timer));
    jobPollTimers.current.clear();
  };

  useEffect(() => () => clearJobPollTimers(), []);

  useEffect(() => {
    pollingSessionActive.current = status === 'ready';
    if (!pollingSessionActive.current) {
      clearJobPollTimers();
    }
  }, [status]);

  // Track initial app open once per browser session load
  useEffect(() => {
    if (!hasTrackedAppOpen.current) {
      hasTrackedAppOpen.current = true;
      recordUsageEvent('APP_OPENED');
    }
  }, []);

  // Track case viewed when active case details change
  useEffect(() => {
    if (selectedCaseDetail && selectedCaseDetail.case_number !== lastViewedCaseRef.current) {
      lastViewedCaseRef.current = selectedCaseDetail.case_number;
      recordUsageEvent('CASE_VIEWED', selectedCaseDetail.case_number);
    }
  }, [selectedCaseDetail]);

  // Fetch Cases list
  const fetchCases = useCallback(
    async (preferredSelectedId?: string | null) => {
      setIsLoadingQueue(true);
      try {
        const fetched = await api.getCases({
          routing_status: activeRoutingFilter === 'ALL' ? undefined : activeRoutingFilter,
          review_decision: activeDecisionFilter === 'ALL' ? undefined : activeDecisionFilter,
          search: searchQuery.trim() || undefined,
        });
        setCases(fetched);
        setHasUnfilteredQueue(activeRoutingFilter === 'ALL' && activeDecisionFilter === 'ALL' && !searchQuery.trim());

        // Keep or auto-select case using functional state update
        setSelectedCaseId((currentSelectedId) => {
          const targetId = preferredSelectedId !== undefined ? preferredSelectedId : currentSelectedId;
          if (targetId && fetched.some((c) => c.id === targetId)) {
            return targetId;
          }
          return fetched.length > 0 ? fetched[0].id : null;
        });

        if (fetched.length === 0) {
          setSelectedCaseDetail(null);
          lastViewedCaseRef.current = null;
        }
      } catch (err) {
        setHasUnfilteredQueue(false);
        const msg = err instanceof ApiError ? err.detail : 'Could not connect to the API. Confirm the backend is running and retry.';
        setFeedback({ type: 'error', message: msg });
      } finally {
        setIsLoadingQueue(false);
      }
    },
    [activeRoutingFilter, activeDecisionFilter, searchQuery]
  );

  // Fetch Case Detail
  const fetchCaseDetail = useCallback(async (caseId: string) => {
    setIsLoadingDetail(true);
    try {
      const detail = await api.getCase(caseId);
      setSelectedCaseDetail(detail);
    } catch (err) {
      const msg = err instanceof ApiError ? err.detail : 'Could not load case detail.';
      setFeedback({ type: 'error', message: msg });
    } finally {
      setIsLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    if (status === 'ready' && workspace) {
      void fetchCases();
    } else {
      setCases([]);
      setHasUnfilteredQueue(false);
      setSelectedCaseId(null);
      setSelectedCaseDetail(null);
      setFeedback(null);
    }
  }, [fetchCases, status, workspace]);

  useEffect(() => {
    if (status === 'ready' && selectedCaseId) {
      void fetchCaseDetail(selectedCaseId);
    }
  }, [selectedCaseId, fetchCaseDetail, status]);

  const handleSelectCase = (caseId: string) => {
    setSelectedCaseId(caseId);
    setMobileView('detail');
  };

  const handleLoadSample = async () => {
    setIsLoadingSample(true);
    setFeedback(null);
    try {
      const res = await api.ingestSample();
      recordUsageEvent('SAMPLE_CASES_LOADED');
      const msg =
        res.created_count > 0
          ? `${res.ingested_count} sample cases available. ${res.created_count} created.`
          : `${res.ingested_count} sample cases available. ${res.existing_count} already existed.`;
      setFeedback({ type: 'success', message: msg });
      await fetchCases(res.case_ids[0]);
    } catch (err) {
      const msg = err instanceof ApiError ? err.detail : 'Failed to load sample cases.';
      setFeedback({ type: 'error', message: msg });
    } finally {
      setIsLoadingSample(false);
    }
  };

  const handleUploadCsv = async (file: File) => {
    setIsUploadingCsv(true);
    setFeedback(null);
    try {
      const res = await api.ingestCsv(file);
      recordUsageEvent('CSV_UPLOADED');
      setFeedback({ type: 'info', message: 'CSV ingestion queued.' });
      const poll = async (): Promise<void> => {
        try {
          const job = await api.getJob(res.id);
          if (!pollingSessionActive.current) return;
          if (job.status === 'SUCCEEDED') {
            setFeedback({ type: 'success', message: `CSV ingestion completed: ${job.successful_rows} cases created.` });
            await fetchCases();
          } else if (job.status === 'FAILED') {
            setFeedback({ type: 'error', message: job.failure_message || 'CSV ingestion failed.' });
          } else {
            setFeedback({ type: 'info', message: `CSV ingestion ${job.status.toLowerCase()}: ${job.processed_rows}/${job.total_rows ?? '?'} rows.` });
            const timer = window.setTimeout(() => {
              jobPollTimers.current.delete(timer);
              void poll();
            }, 1500);
            jobPollTimers.current.add(timer);
          }
        } catch { setFeedback({ type: 'error', message: 'Could not check CSV ingestion status.' }); }
      };
      void poll();
    } catch (err) {
      const msg = err instanceof ApiError ? err.detail : 'Failed to process uploaded CSV.';
      setFeedback({ type: 'error', message: msg });
    } finally {
      setIsUploadingCsv(false);
    }
  };

  const handleExportCsv = async () => {
    setIsExportingCsv(true);
    setFeedback(null);
    try {
      const blob = await api.exportReviewedCsv();
      recordUsageEvent('CSV_EXPORTED');
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `reviewed_cases_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      setFeedback({ type: 'success', message: 'Downloaded reviewed cases CSV.' });
    } catch (err) {
      const msg = err instanceof ApiError ? err.detail : 'Failed to export reviewed cases.';
      setFeedback({ type: 'error', message: msg });
    } finally {
      setIsExportingCsv(false);
    }
  };

  const handleSubmitDecision = async (
    decision: ReviewDecision,
    candidateId?: string | null,
    notes?: string | null
  ) => {
    if (!selectedCaseId) return;
    setIsSubmittingDecision(true);
    setFeedback(null);
    try {
      const updated = await api.submitDecision(selectedCaseId, {
        decision,
        selected_candidate_id: candidateId,
        notes,
      });
      recordUsageEvent('DECISION_SUBMITTED', updated.case_number);
      setSelectedCaseDetail(updated);
      setFeedback({
        type: 'success',
        message: `Recorded decision: ${decision.replace('_', ' ')}`,
      });
      // Refresh summaries in queue
      await fetchCases(selectedCaseId);
    } catch (err) {
      const msg = err instanceof ApiError ? err.detail : 'Failed to submit decision.';
      setFeedback({ type: 'error', message: msg });
    } finally {
      setIsSubmittingDecision(false);
    }
  };


  const handleCaseCreatedFromAi = async (caseNumber: string) => {
    const refreshed = await api.getCases();
    setCases(refreshed);
    const created = refreshed.find((item) => item.case_number === caseNumber);
    if (created) {
      setSelectedCaseId(created.id);
      setMobileView('detail');
    }
    setFeedback({
      type: 'success',
      message: created
        ? 'AI extraction completed and case loaded into resolution workbench.'
        : 'AI extraction completed. The case queue was refreshed.',
    });
  };

  if (status === 'loading' || status === 'bootstrapping') {
    return <main className="flex min-h-screen items-center justify-center bg-background text-sm text-muted">Starting your workspace…</main>;
  }
  if (status !== 'ready') return <AuthScreen />;

  // The queue is filtered server side; use only unfiltered results for
  // the first use state and workspace-wide export availability.
  const hasFilters = activeRoutingFilter !== 'ALL' || activeDecisionFilter !== 'ALL' || searchQuery.trim() !== '';
  const isEmptyWorkspace = hasUnfilteredQueue && !hasFilters && cases.length === 0 && !isLoadingQueue;
  const exportDisabled = hasUnfilteredQueue && !hasFilters && !isLoadingQueue && !cases.some((item) => item.review_decision !== 'PENDING');

  return (
    <>
      <AppShell
        onNavigate={setPage}
        activePage={page}
        exportDisabled={exportDisabled}
        onLoadSample={handleLoadSample}
        onUploadCsv={handleUploadCsv}
        onExportCsv={handleExportCsv}
        onOpenAiModal={() => setIsAiModalOpen(true)}
        onRetry={() => fetchCases()}
        isLoadingSample={isLoadingSample}
        isUploadingCsv={isUploadingCsv}
        isExportingCsv={isExportingCsv}
        feedback={feedback}
        onClearFeedback={() => setFeedback(null)}
        onSignOut={signOutUser}
      >
        <div className={`cases-layout ${isEmptyWorkspace ? 'is-empty' : ''}`}>
          {page === 'sources' ? <Sources key={workspace?.id} owner={workspace?.role === 'OWNER'} onReview={() => { setPage('cases'); void fetchCases(); }} /> : <>
          {/* Case Queue Column */}
          <div
            className={`case-queue-column md:flex ${
              mobileView === 'queue' || isEmptyWorkspace ? 'flex' : 'hidden md:flex'
            }`}
          >
            <CaseQueue
              cases={cases}
              selectedCaseId={selectedCaseId}
              onSelectCase={handleSelectCase}
              activeRoutingFilter={activeRoutingFilter}
              onRoutingFilterChange={setActiveRoutingFilter}
              activeDecisionFilter={activeDecisionFilter}
              onDecisionFilterChange={setActiveDecisionFilter}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              isLoading={isLoadingQueue}
              showFilters={cases.length > 0 || hasFilters}
            />
          </div>

          {/* Case Detail Workspace */}
          <div
            className={`case-detail-column md:flex ${
              mobileView === 'detail' || isEmptyWorkspace ? 'flex' : 'hidden md:flex'
            }`}
          >
            {isEmptyWorkspace ? <div className="workspace-empty"><div>
              <h2>Start reviewing cases</h2>
              <p>Load sample data to explore the workflow or upload your own CSV file.</p>
              <div className="empty-actions">
                <button type="button" className="shell-button shell-button-primary" onClick={() => void handleLoadSample()} disabled={isLoadingSample || isUploadingCsv}>Load sample cases</button>
                <button type="button" className="shell-button shell-button-bordered" onClick={() => document.getElementById('csv-upload-input')?.click()} disabled={isLoadingSample || isUploadingCsv}>Upload CSV</button>
              </div>
            </div></div> : <CaseDetail
              key={workspace?.id}
              onRefresh={() => { if (selectedCaseId) { void fetchCaseDetail(selectedCaseId); void fetchCases(selectedCaseId); } }}
              caseDetail={selectedCaseDetail}
              isLoading={isLoadingDetail}
              onBackMobile={() => setMobileView('queue')}
              onSubmitDecision={handleSubmitDecision}
              isSubmittingDecision={isSubmittingDecision}
            />}
          </div>
          </>}
        </div>
      </AppShell>

      <AiExtractionModal
        isOpen={isAiModalOpen}
        onClose={() => setIsAiModalOpen(false)}
        onCaseCreated={handleCaseCreatedFromAi}
      />
    </>
  );
}

export default App;
