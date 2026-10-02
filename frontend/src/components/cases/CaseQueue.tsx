import React from 'react';
import {
  AlertTriangle,
  CheckCircle,
  HelpCircle,
  Search,
  SlidersHorizontal,
  XCircle,
} from 'lucide-react';
import type { CaseSummary, ReviewDecision, RoutingStatus } from '../../types';

interface CaseQueueProps {
  cases: CaseSummary[];
  selectedCaseId: string | null;
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

export const CaseQueue: React.FC<CaseQueueProps> = ({
  cases,
  selectedCaseId,
  onSelectCase,
  activeRoutingFilter,
  onRoutingFilterChange,
  activeDecisionFilter,
  onDecisionFilterChange,
  searchQuery,
  onSearchChange,
  isLoading,
  showFilters,
}) => {
  const routingTabs: { key: RoutingStatus | 'ALL'; label: string }[] = [
    { key: 'ALL', label: 'All Cases' },
    { key: 'LIKELY_MATCH', label: 'Likely Match' },
    { key: 'NEEDS_REVIEW', label: 'Needs Review' },
    { key: 'NO_RELIABLE_MATCH', label: 'No Match' },
  ];

  return (
    <aside className="case-queue flex h-full flex-col border-r border-border bg-surface shrink-0">
      {/* Queue Header */}
      <div className="border-b border-border p-3.5 space-y-1">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-bold uppercase tracking-wider text-foreground">Cases</h2>
          <span className="font-mono text-[10px] text-muted">{cases.length} total</span>
        </div>
        <p className="text-[11px] text-muted leading-tight">
          Review possible contact matches and confirm the correct record.
        </p>
      </div>

      {/* Search & Filter Header */}
      {showFilters && <div className="border-b border-border p-3 space-y-2.5">
        {/* Search Input */}
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted" />
          <input
            type="text"
            placeholder="Search by case #, name, employer..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full rounded border border-border bg-background py-1.5 pl-8 pr-3 text-xs text-foreground placeholder:text-muted focus:border-accent focus-visible:ring-1 focus-visible:ring-accent focus:outline-none"
            aria-label="Search cases"
          />
        </div>

        {/* Status Filter Tabs */}
        <div className="flex rounded border border-border bg-surface p-0.5 text-xs">
          {routingTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => onRoutingFilterChange(tab.key)}
              aria-pressed={activeRoutingFilter === tab.key}
              className={`flex-1 rounded py-1 text-center text-[11px] font-medium transition-colors ${
                activeRoutingFilter === tab.key
                  ? 'bg-accent-muted text-accent'
                  : 'text-muted hover:text-foreground'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Secondary Decision Filter */}
        <div className="flex items-center justify-between text-[11px] text-muted">
          <div className="flex items-center space-x-1">
            <SlidersHorizontal className="h-3 w-3" />
            <span>Decision filter:</span>
          </div>
          <select
            aria-label="Decision filter"
            value={activeDecisionFilter}
            onChange={(e) => onDecisionFilterChange(e.target.value as ReviewDecision | 'ALL')}
            className="rounded border border-border bg-surface px-2 py-0.5 text-[11px] text-foreground focus:border-accent focus:outline-none"
          >
            <option value="ALL">All Decisions</option>
            <option value="PENDING">Pending Only</option>
            <option value="ACCEPTED">Accepted</option>
            <option value="REJECTED">Rejected</option>
            <option value="NEED_MORE_EVIDENCE">Need Evidence</option>
          </select>
        </div>
      </div>}

      {/* Case Queue List */}
      <div className="flex-1 overflow-y-auto divide-y divide-border">
        {isLoading ? (
          <div className="p-8 text-center text-xs text-muted">Loading cases...</div>
        ) : cases.length === 0 ? (
          <div className="px-4 py-7 text-xs text-muted">
            <p>{showFilters ? 'No cases match your filters' : 'No cases yet'}</p>
          </div>
        ) : (
          cases.map((c) => {
            const isSelected = c.id === selectedCaseId;

            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelectCase(c.id)}
                aria-current={isSelected ? 'true' : undefined}
                className={`w-full text-left p-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
                  isSelected
                    ? 'bg-accent-muted border-l-4 border-l-accent'
                    : 'hover:bg-surface-muted'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] font-semibold text-muted">
                    {c.case_number}
                  </span>
                  <div className="flex items-center space-x-1.5">
                    {c.has_serious_contradiction && (
                      <span
                        className="inline-flex items-center space-x-0.5 rounded bg-rose-100 px-1 py-0.5 text-[9px] font-semibold text-rose-800"
                        title="Serious contradiction detected"
                      >
                        <AlertTriangle className="h-2.5 w-2.5" />
                        <span>Conflict</span>
                      </span>
                    )}
                    <span
                      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        c.routing_status === 'LIKELY_MATCH'
                          ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                          : c.routing_status === 'NEEDS_REVIEW'
                          ? 'bg-amber-50 text-amber-800 border border-amber-200'
                          : 'bg-slate-100 text-slate-700 border border-slate-200'
                      }`}
                    >
                      {c.routing_status === 'LIKELY_MATCH' && 'Likely Match'}
                      {c.routing_status === 'NEEDS_REVIEW' && 'Needs Review'}
                      {c.routing_status === 'NO_RELIABLE_MATCH' && 'No Match'}
                    </span>
                  </div>
                </div>

                <div className="mt-1 flex items-baseline justify-between">
                  <p className="text-xs font-medium text-foreground truncate max-w-[180px]">
                    {c.person_name}
                  </p>
                  <span className="font-mono text-[11px] font-semibold text-slate-900">
                    {c.top_score} <span className="text-[9px] text-muted">/ 100</span>
                  </span>
                </div>

                <div className="mt-1 flex items-center justify-between text-[11px] text-muted">
                  <span className="truncate max-w-[180px]">
                    {c.employer || c.location || 'No employer noted'}
                  </span>

                  {/* Decision Tag */}
                  <div className="flex items-center space-x-1">
                    {c.review_decision === 'ACCEPTED' && (
                      <span className="inline-flex items-center space-x-1 text-emerald-700 font-medium text-[10px]">
                        <CheckCircle className="h-3 w-3" />
                        <span>Accepted</span>
                      </span>
                    )}
                    {c.review_decision === 'REJECTED' && (
                      <span className="inline-flex items-center space-x-1 text-rose-700 font-medium text-[10px]">
                        <XCircle className="h-3 w-3" />
                        <span>Rejected</span>
                      </span>
                    )}
                    {c.review_decision === 'NEED_MORE_EVIDENCE' && (
                      <span className="inline-flex items-center space-x-1 text-amber-700 font-medium text-[10px]">
                        <HelpCircle className="h-3 w-3" />
                        <span>Need Info</span>
                      </span>
                    )}
                    {c.review_decision === 'PENDING' && (
                      <span className="text-[10px] text-muted">Pending</span>
                    )}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
};
