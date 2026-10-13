import { useEffect, useRef } from 'react';
import { AlertTriangle, Search } from 'lucide-react';
import type { CaseSummary, ReviewDecision, RoutingStatus } from '../../types';
import { TextInput } from '../ui/Field';
import { StatusIndicator } from '../ui/Feedback';
import { decisionLabel, recommendationLabel, recommendationTone } from './casePresentation';
import './Cases.css';

interface CaseQueueProps {
  cases: CaseSummary[];
  selectedCaseId: string | null;
  mobileQueueActive?: boolean;
  onSelectCase: (caseId: string) => void;
  activeRoutingFilter: RoutingStatus | 'ALL';
  onRoutingFilterChange: (filter: RoutingStatus | 'ALL') => void;
  activeDecisionFilter: ReviewDecision | 'ALL';
  onDecisionFilterChange: (filter: ReviewDecision | 'ALL') => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  isLoading: boolean;
  showFilters: boolean;
}

export function CaseQueue({ cases, selectedCaseId, onSelectCase, activeRoutingFilter, onRoutingFilterChange,
  activeDecisionFilter, onDecisionFilterChange, searchQuery, onSearchChange, isLoading, showFilters, mobileQueueActive = true }: CaseQueueProps) {
  const rootRef = useRef<HTMLElement>(null);
  const wasQueueActive = useRef(mobileQueueActive);
  useEffect(() => {
    if (mobileQueueActive && !wasQueueActive.current && window.matchMedia('(max-width: 767px)').matches) {
      const target = rootRef.current?.querySelector<HTMLElement>('[aria-current="true"]')
        || rootRef.current?.querySelector<HTMLInputElement>('input') || rootRef.current;
      target?.focus({ preventScroll: true });
    }
    wasQueueActive.current = mobileQueueActive;
  }, [mobileQueueActive]);
  const filtered = activeRoutingFilter !== 'ALL' || activeDecisionFilter !== 'ALL' || !!searchQuery.trim();
  return <aside ref={rootRef} tabIndex={-1} className="case-queue" aria-label="Cases queue">
    <div className="case-queue-controls">
      <div className="case-section-heading"><h2>Review queue</h2><span className="case-metadata" role="status">{isLoading ? 'Updating…' : `${cases.length} ${filtered ? cases.length === 1 ? 'result' : 'results' : cases.length === 1 ? 'case' : 'cases'} shown`}</span></div>
      {showFilters && <>
        <div className="case-search"><Search size={16} aria-hidden="true" /><TextInput type="text" aria-label="Search cases" placeholder="Search cases…" value={searchQuery} onChange={event => onSearchChange(event.target.value)} /></div>
        <div className="case-filters">
          <label htmlFor="case-recommendation-filter">Recommendation</label>
          <select id="case-recommendation-filter" value={activeRoutingFilter} onChange={event => onRoutingFilterChange(event.target.value as RoutingStatus | 'ALL')}>
            <option value="ALL">All recommendations</option><option value="LIKELY_MATCH">Likely Match</option><option value="NEEDS_REVIEW">Needs Review</option><option value="NO_RELIABLE_MATCH">No Match</option>
          </select>
          <label htmlFor="case-decision-filter">Decision filter</label>
          <select id="case-decision-filter" value={activeDecisionFilter} onChange={event => onDecisionFilterChange(event.target.value as ReviewDecision | 'ALL')}>
            <option value="ALL">All Decisions</option><option value="PENDING">Pending Only</option><option value="ACCEPTED">Accepted</option><option value="REJECTED">Rejected</option><option value="NEED_MORE_EVIDENCE">Need Evidence</option>
          </select>
        </div>
      </>}
    </div>
    <div className="case-queue-list" aria-busy={isLoading}>
      {isLoading ? <p className="case-queue-empty" role="status">Loading cases...</p> : cases.length === 0 ? <p className="case-queue-empty">{showFilters ? 'No cases match your filters' : 'No cases yet'}</p> : cases.map(item => <button key={item.id} type="button" className="case-queue-row" aria-current={item.id === selectedCaseId ? 'true' : undefined} onClick={() => onSelectCase(item.id)}>
        <span className="case-row-top"><span className="case-metadata">{item.case_number}</span><span className="case-row-score">{item.candidate_count > 0 ? `${item.top_score} / 100` : 'No score'}</span></span>
        <strong className="case-row-name">{item.person_name}</strong>
        <span className="case-row-context">{[item.employer, item.location].filter(Boolean).join(' · ') || 'No organization or location provided'}</span>
        <StatusIndicator tone={recommendationTone(item.routing_status)}>{recommendationLabel[item.routing_status]}</StatusIndicator>
        <span className="case-row-bottom"><span>{item.has_serious_contradiction ? <span className="case-conflict-text"><AlertTriangle size={14} aria-hidden="true" />Serious conflict</span> : `${item.candidate_count} ${item.candidate_count === 1 ? 'candidate' : 'candidates'}`}</span><span>Human: {decisionLabel[item.review_decision]}</span></span>
        {item.id === selectedCaseId && <span className="sr-only">Selected case</span>}
      </button>)}
    </div>
  </aside>;
}
