import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api/client';
import { AppShell } from './components/layout/AppShell';
import { CaseDetail } from './components/cases/CaseDetail';
import { CaseQueue } from './components/cases/CaseQueue';
import type {
  CaseDetail as CaseDetailType,
  CaseSummary,
  ReviewDecision,
  RoutingStatus,
} from './types';

export function App() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
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

  const [mobileView, setMobileView] = useState<'queue' | 'detail'>('queue');
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error' | 'info';
    message: string;
  } | null>(null);

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
        }
      } catch (err) {
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
    fetchCases();
  }, [fetchCases]);

  useEffect(() => {
    if (selectedCaseId) {
      fetchCaseDetail(selectedCaseId);
    }
  }, [selectedCaseId, fetchCaseDetail]);

  const handleSelectCase = (caseId: string) => {
    setSelectedCaseId(caseId);
    setMobileView('detail');
  };

  const handleLoadSample = async () => {
    setIsLoadingSample(true);
    setFeedback(null);
    try {
      const res = await api.ingestSample();
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
      setFeedback({
        type: 'success',
        message: `Successfully ingested CSV batch: ${res.ingested_count} cases created.`,
      });
      await fetchCases(res.case_ids[0]);
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

  return (
    <AppShell
      onLoadSample={handleLoadSample}
      onUploadCsv={handleUploadCsv}
      onExportCsv={handleExportCsv}
      onRetry={() => fetchCases()}
      isLoadingSample={isLoadingSample}
      isUploadingCsv={isUploadingCsv}
      isExportingCsv={isExportingCsv}
      feedback={feedback}
      onClearFeedback={() => setFeedback(null)}
    >
      <div className="flex h-full w-full overflow-hidden">
        {/* Case Queue Column */}
        <div
          className={`h-full shrink-0 sm:flex ${
            mobileView === 'queue' ? 'flex w-full' : 'hidden sm:flex'
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
            onLoadSample={handleLoadSample}
            onTriggerUpload={() => document.getElementById('csv-upload-input')?.click()}
          />
        </div>

        {/* Case Detail Workspace */}
        <div
          className={`h-full flex-1 overflow-hidden sm:flex ${
            mobileView === 'detail' ? 'flex w-full' : 'hidden sm:flex'
          }`}
        >
          <CaseDetail
            caseDetail={selectedCaseDetail}
            isLoading={isLoadingDetail}
            onBackMobile={() => setMobileView('queue')}
            onSubmitDecision={handleSubmitDecision}
            isSubmittingDecision={isSubmittingDecision}
          />
        </div>
      </div>
    </AppShell>
  );
}

export default App;
