import React from 'react';
import { Award, Check, FileQuestion, HelpCircle, Minus, X } from 'lucide-react';
import type { CandidateDetail } from '../../types';

interface EvidenceMatrixProps {
  activeCandidate: CandidateDetail;
}

export const EvidenceMatrix: React.FC<EvidenceMatrixProps> = ({
  activeCandidate,
}) => {
  const getMethodBadge = (method: string, points: number, maxPoints: number) => {
    if (points === maxPoints && maxPoints > 0) {
      return (
        <span className="inline-flex items-center space-x-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 border border-emerald-200">
          <Check className="h-2.5 w-2.5" />
          <span>Exact Match</span>
        </span>
      );
    }
    if (points > 0) {
      return (
        <span className="inline-flex items-center space-x-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 border border-amber-200">
          <HelpCircle className="h-2.5 w-2.5" />
          <span>Partial Match</span>
        </span>
      );
    }
    if (method === 'MISSING') {
      return (
        <span className="inline-flex items-center space-x-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 border border-slate-200">
          <Minus className="h-2.5 w-2.5" />
          <span>Missing Field</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center space-x-1 rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-800 border border-rose-200">
        <X className="h-2.5 w-2.5" />
        <span>Different</span>
      </span>
    );
  };

  return (
    <div className="rounded border border-border bg-surface p-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-border gap-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
            Evidence Comparison & Scoring
          </h3>
          <p className="mt-0.5 text-[11px] text-muted">
            Deterministic field-level points for <span className="font-medium text-foreground">{activeCandidate.name}</span>
          </p>
        </div>

        {/* Provenance Tag */}
        <div className="rounded border border-border bg-surface-muted px-2.5 py-1 text-[11px] text-slate-700">
          <span className="font-semibold text-foreground">Source:</span> {activeCandidate.provenance_summary}
        </div>
      </div>

      {/* Desktop Evidence Table */}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-border bg-surface-muted/50 text-[11px] font-medium text-muted">
              <th className="py-2 px-3">Field</th>
              <th className="py-2 px-3">Original Record</th>
              <th className="py-2 px-3">Candidate Record</th>
              <th className="py-2 px-3">Evidence Explanation</th>
              <th className="py-2 px-3 text-right">Points</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {activeCandidate.evidence.map((ev) => {
              const fieldLabel = ev.field_name.charAt(0).toUpperCase() + ev.field_name.slice(1);

              return (
                <tr key={ev.field_name} className="hover:bg-surface-muted/30">
                  <td className="py-2.5 px-3 font-medium text-foreground whitespace-nowrap">
                    {fieldLabel}
                  </td>
                  <td className="py-2.5 px-3 text-slate-700">
                    {ev.source_value || <span className="text-muted italic">Not provided</span>}
                  </td>
                  <td className="py-2.5 px-3 font-medium text-foreground">
                    {ev.candidate_value || <span className="text-muted italic">Not provided</span>}
                  </td>
                  <td className="py-2.5 px-3">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-1.5">
                      {getMethodBadge(ev.match_method, ev.points_awarded, ev.max_points)}
                      <span className="text-[11px] text-slate-600">{ev.explanation}</span>
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono font-semibold whitespace-nowrap">
                    <span className={ev.points_awarded > 0 ? 'text-emerald-700' : 'text-slate-400'}>
                      {ev.points_awarded}
                    </span>
                    <span className="text-[10px] font-normal text-muted"> / {ev.max_points}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-border bg-surface-muted/60 font-medium">
              <td colSpan={4} className="py-2.5 px-3 text-xs text-foreground">
                <div className="flex items-center space-x-1.5">
                  <Award className="h-4 w-4 text-accent" />
                  <span className="font-semibold">Total Deterministic Evidence Score</span>
                  <span className="text-[11px] text-muted">(Capped at 100 max points)</span>
                </div>
              </td>
              <td className="py-2.5 px-3 text-right font-mono text-sm font-bold text-foreground">
                {activeCandidate.total_score} <span className="text-xs font-normal text-muted">/ 100</span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mt-2 text-[10px] text-muted flex items-center space-x-1">
        <FileQuestion className="h-3 w-3 shrink-0" />
        <span>Evidence scores summarize deterministic field matches; they are not identity probabilities.</span>
      </div>
    </div>
  );
};
