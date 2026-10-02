import React from 'react';
import { AlertTriangle, Database } from 'lucide-react';
import type { CandidateDetail } from '../../types';

interface CandidateListProps {
  candidates: CandidateDetail[];
  selectedCandidateId: string | null;
  onSelectCandidate: (candidateId: string) => void;
}

export const CandidateList: React.FC<CandidateListProps> = ({
  candidates,
  selectedCandidateId,
  onSelectCandidate,
}) => {
  if (candidates.length === 0) {
    return (
      <div className="rounded border border-border bg-surface p-4 text-center">
        <p className="text-xs font-medium text-foreground">No matching candidates found</p>
        <p className="mt-1 text-[11px] text-muted">
          Synthetic providers returned 0 matching records for this identity.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded border border-border bg-surface p-4">
      <div className="flex items-center justify-between pb-3 border-b border-border">
        <div className="flex items-center space-x-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
            Possible Candidate Matches ({candidates.length})
          </h3>
          <span className="text-[11px] text-muted">Select a candidate to view evidence</span>
        </div>
      </div>

      <div className="candidate-grid mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {candidates.map((cand, index) => {
          const isSelected = cand.id === selectedCandidateId;
          const candidateLetter = String.fromCharCode(65 + index); // A, B, C...

          return (
            <button
              key={cand.id}
              type="button"
              onClick={() => onSelectCandidate(cand.id)}
              className={`flex flex-col text-left rounded border p-3 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                isSelected
                  ? 'border-accent bg-accent-muted/40 shadow-sm ring-1 ring-accent'
                  : 'border-border bg-surface hover:bg-surface-muted/60'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-1.5">
                  <span className="inline-flex items-center justify-center rounded bg-surface-muted px-1.5 py-0.5 text-[10px] font-bold text-foreground">
                    Candidate {candidateLetter}
                  </span>
                  {isSelected && (
                    <span className="text-[10px] font-semibold text-accent">
                      Active
                    </span>
                  )}
                </div>
                <span className="font-mono text-xs font-bold text-foreground">
                  {cand.total_score} <span className="text-[9px] font-normal text-muted">/ 100</span>
                </span>
              </div>

              <p className="mt-1.5 text-xs font-semibold text-foreground truncate">
                {cand.name}
              </p>

              <div className="mt-1.5 flex items-center justify-between text-[10px]">
                <div className="flex items-center space-x-1 text-muted">
                  <Database className="h-3 w-3 shrink-0" />
                  <span className="truncate max-w-[140px]">{cand.provider_source}</span>
                </div>

                {cand.has_serious_contradiction && (
                  <span className="inline-flex items-center space-x-0.5 text-rose-700 font-medium">
                    <AlertTriangle className="h-3 w-3" />
                    <span>Conflict</span>
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
