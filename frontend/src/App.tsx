import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, ApiError } from './api/client';
import { Sources } from './components/Sources';
import { AuthScreen } from './auth/AuthScreen';
import { useAuth } from './auth/AuthProvider';
import { recordUsageEvent } from './api/telemetry';
import { AppShell } from './components/layout/AppShell';
import { AiExtractionModal } from './components/cases/AiExtractionModal';
import { RecentActivity } from './components/jobs/RecentActivity';
import { isLongRunning } from './components/jobs/jobPresentation';
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
  const [reviewNeedsCheck, setReviewNeedsCheck] = useState<string | null>(null);
  const [isAiModalOpen, setIsAiModalOpen] = useState(false);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [activityRevision, setActivityRevision] = useState(0);

  const [mobileView, setMobileView] = useState<'queue' | 'detail'>('queue');
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error' | 'info';
    message: string;
    action?: { label: string; run: () => void };
  } | null>(null);

  const hasTrackedAppOpen = useRef(false);
  const lastViewedCaseRef = useRef<string | null>(null);
  const jobPollTimers = useRef(new Set<number>());
  const csvRequest = useRef(0);
  const pollingSession = useRef({ active: status === 'ready', workspaceId: workspace?.id });
  const detailRequestId = useRef(0);
  const reviewInFlight = useRef(false);
  const reviewView = useRef({ caseId: selectedCaseId, workspaceId: workspace?.id, active: false, ready: false });
  const isReviewReady = status === 'ready' && !!workspace && !!selectedCaseDetail
    && selectedCaseDetail.id === selectedCaseId && !isLoadingDetail && reviewNeedsCheck !== selectedCaseId;

  // A new committed selection/session owns a distinct view, including A -> B -> A.
  useLayoutEffect(() => {
    const view = { caseId: selectedCaseId, workspaceId: workspace?.id, active: status === 'ready', ready: false };
    reviewView.current = view;
    return () => {
      view.active = false;
      detailRequestId.current += 1;
    };
  }, [selectedCaseId, workspace?.id, status]);
  useLayoutEffect(() => { reviewView.current.ready = isReviewReady; });

  const clearJobPollTimers = () => {
    jobPollTimers.current.forEach((timer) => window.clearTimeout(timer));
    jobPollTimers.current.clear();
  };

  useEffect(() => () => clearJobPollTimers(), []);

  useLayoutEffect(() => {
    const session = { active: status === 'ready', workspaceId: workspace?.id };
    pollingSession.current = session;
    setIsAiModalOpen(false);
    setActivityExpanded(false);
    return () => { session.active = false; clearJobPollTimers(); };
  }, [status, workspace?.id]);

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
    async (preferredSelectedId?: string | null, canApplyReviewRefresh?: () => boolean, preserveSelection = true) => {
      setIsLoadingQueue(true);
      try {
        const fetched = await api.getCases({
          routing_status: activeRoutingFilter === 'ALL' ? undefined : activeRoutingFilter,
          review_decision: activeDecisionFilter === 'ALL' ? undefined : activeDecisionFilter,
          search: searchQuery.trim() || undefined,
        });
        if (canApplyReviewRefresh && !canApplyReviewRefresh()) return;
        setCases(fetched);
        setHasUnfilteredQueue(activeRoutingFilter === 'ALL' && activeDecisionFilter === 'ALL' && !searchQuery.trim());

        // Review refreshes only update the queue, never change the reviewer's selection.
        if (!canApplyReviewRefresh || !preserveSelection) {
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
        }
      } catch (err) {
        if (canApplyReviewRefresh && !canApplyReviewRefresh()) return;
        setHasUnfilteredQueue(false);
        const msg = err instanceof ApiError ? err.detail : 'Could not connect to the API. Confirm the backend is running and retry.';
        setFeedback({ type: 'error', message: msg, action: { label: 'Refresh cases', run: () => void fetchCases() } });
      } finally {
        setIsLoadingQueue(false);
      }
    },
    [activeRoutingFilter, activeDecisionFilter, searchQuery]
  );
  const currentQueueFetcher = useRef(fetchCases);
  useLayoutEffect(() => { currentQueueFetcher.current = fetchCases; }, [fetchCases]);

  // Fetch Case Detail
  const fetchCaseDetail = useCallback(async (caseId: string) => {
    const view = reviewView.current;
    if (!view.active || view.caseId !== caseId) return;
    const requestId = ++detailRequestId.current;
    const isCurrent = () => reviewView.current === view && view.active && detailRequestId.current === requestId;
    view.ready = false;
    setIsLoadingDetail(true);
    try {
      const detail = await api.getCase(caseId);
      if (!isCurrent()) return;
      if (detail.id !== caseId) throw new Error('Case detail did not match the requested case.');
      setSelectedCaseDetail(detail);
      setReviewNeedsCheck(current => current === caseId ? null : current);
    } catch (err) {
      if (!isCurrent()) return;
      const msg = err instanceof ApiError ? err.detail : 'Could not load case detail.';
      setFeedback({ type: 'error', message: msg, action: { label: 'Refresh case', run: () => void fetchCaseDetail(caseId) } });
    } finally {
      if (isCurrent()) setIsLoadingDetail(false);
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
    if (caseId !== selectedCaseId) {
      reviewView.current.active = false;
      detailRequestId.current += 1;
    }
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
    const session = pollingSession.current;
    const request = ++csvRequest.current;
    clearJobPollTimers();
    const current = () => session.active && pollingSession.current === session && csvRequest.current === request;
    setIsUploadingCsv(true);
    setFeedback(null);
    try {
      const res = await api.ingestCsv(file);
      if (!current()) return;
      setActivityRevision(value => value + 1);
      recordUsageEvent('CSV_UPLOADED');
      setFeedback({ type: 'info', message: 'CSV uploaded. Waiting for the import result.' });
      let checking = false;
      const poll = async (): Promise<void> => {
        if (!current() || checking) return;
        checking = true;
        try {
          const job = await api.getJob(res.id);
          if (!current()) return;
          if (job.id !== res.id || job.workspace_id !== session.workspaceId) throw Error('Unexpected Job');
          if (job.status === 'SUCCEEDED') {
            setFeedback({ type: 'success', message: `${job.successful_rows} ${job.successful_rows === 1 ? 'record' : 'records'} imported.` });
            setActivityRevision(value => value + 1);
            await fetchCases(undefined, current, false);
          } else if (job.status === 'FAILED') {
            setActivityRevision(value => value + 1);
            setFeedback({ type: 'error', message: `No records were imported. ${job.failure_message || 'Fix the CSV and try again.'}`, action: { label: 'View recent activity', run: () => setActivityExpanded(true) } });
          } else {
            setFeedback({ type: 'info', message: isLongRunning(job) ? 'This is taking longer than expected.' : 'Importing your CSV. Waiting for the result.', action: { label: 'View recent activity', run: () => setActivityExpanded(true) } });
            const timer = window.setTimeout(() => {
              jobPollTimers.current.delete(timer);
              void poll();
            }, 1500);
            jobPollTimers.current.add(timer);
          }
        } catch {
          if (current()) setFeedback({ type: 'error', message: 'Could not check the latest status. The import outcome is unknown.', action: { label: 'Check again', run: () => { if (current()) void poll(); } } });
        } finally { checking = false; }
      };
      void poll();
    } catch {
      if (!current()) return;
      setActivityRevision(value => value + 1);
      setFeedback({ type: 'error', message: 'Could not confirm the CSV import. Check Recent activity before uploading again.', action: { label: 'View recent activity', run: () => setActivityExpanded(true) } });
    } finally {
      if (current()) setIsUploadingCsv(false);
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
      setFeedback({ type: 'error', message: msg, action: { label: 'Try export again', run: () => void handleExportCsv() } });
    } finally {
      setIsExportingCsv(false);
    }
  };

  const handleSubmitDecision = async (
    renderedCaseId: string,
    decision: ReviewDecision,
    candidateId?: string | null,
    notes?: string | null
  ) => {
    const view = reviewView.current;
    // Fail closed: the rendered identity, committed selection and loaded detail must agree.
    if (!view.active || !view.ready || reviewInFlight.current || !isReviewReady
      || view.caseId !== renderedCaseId || selectedCaseDetail?.id !== renderedCaseId) return;
    const isCurrentView = () => reviewView.current === view && view.active;
    const isCurrentRefresh = () => isCurrentView() && currentQueueFetcher.current === fetchCases;
    reviewInFlight.current = true;
    detailRequestId.current += 1;
    setIsSubmittingDecision(true);
    setFeedback(null);
    try {
      const updated = await api.submitDecision(renderedCaseId, {
        decision,
        selected_candidate_id: candidateId,
        notes,
      });
      if (updated.id !== renderedCaseId) {
        if (isCurrentView()) {
          setReviewNeedsCheck(renderedCaseId);
          setFeedback({ type: 'error', message: 'Could not confirm the review decision. Refresh this case to check the saved decision.', action: { label: 'Refresh case', run: () => { if (isCurrentView()) void fetchCaseDetail(renderedCaseId); } } });
        }
        return;
      }
      recordUsageEvent('DECISION_SUBMITTED', updated.case_number);
      if (reviewView.current.active && reviewView.current.workspaceId === view.workspaceId) {
        setCases(current => current.map(item => item.id === renderedCaseId
          ? { ...item, review_decision: updated.review_decision } : item));
      }
      if (!isCurrentView()) return;
      detailRequestId.current += 1;
      setIsLoadingDetail(false);
      setSelectedCaseDetail(updated);
      setFeedback({
        type: 'success',
        message: `Recorded decision: ${decision.replace('_', ' ')}`,
      });
      // Refresh summaries in queue
      await fetchCases(undefined, isCurrentRefresh);
    } catch {
      if (!isCurrentView()) return;
      setReviewNeedsCheck(renderedCaseId);
      setFeedback({ type: 'error', message: 'Could not confirm the review decision. Refresh this case to check the saved decision before submitting again.', action: { label: 'Refresh case', run: () => {
        if (!isCurrentView()) return;
        void fetchCaseDetail(renderedCaseId);
        void fetchCases(undefined, isCurrentRefresh);
      } } });
    } finally {
      reviewInFlight.current = false;
      setIsSubmittingDecision(false);
    }
  };


  const handleCaseCreatedFromAi = async (caseNumber: string, canApply: () => boolean) => {
    const session = pollingSession.current;
    const refreshed = await api.getCases();
    if (!canApply() || !session.active || pollingSession.current !== session) return;
    setActivityRevision(value => value + 1);
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
        activity={workspace && <RecentActivity key={workspace.id} workspaceId={workspace.id} revision={activityRevision} expanded={activityExpanded} onToggle={() => setActivityExpanded(value => !value)} onRefreshCases={() => void fetchCases()} />}
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
              onRefresh={() => {
                const view = reviewView.current;
                if (view.active && selectedCaseDetail?.id === view.caseId && view.caseId) {
                  void fetchCaseDetail(view.caseId);
                  void fetchCases(undefined, () => reviewView.current === view && view.active && currentQueueFetcher.current === fetchCases);
                }
              }}
              caseDetail={selectedCaseDetail}
              isLoading={isLoadingDetail}
              onBackMobile={() => setMobileView('queue')}
              onSubmitDecision={handleSubmitDecision}
              isSubmittingDecision={isSubmittingDecision}
              isReviewReady={isReviewReady}
            />}
          </div>
          </>}
        </div>
      </AppShell>

      <AiExtractionModal
        key={workspace?.id}
        isOpen={isAiModalOpen}
        onClose={() => setIsAiModalOpen(false)}
        onCaseCreated={handleCaseCreatedFromAi}
        onJobAccepted={() => setActivityRevision(value => value + 1)}
      />
    </>
  );
}

export default App;
