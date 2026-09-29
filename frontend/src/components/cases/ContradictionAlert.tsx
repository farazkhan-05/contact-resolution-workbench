import React from 'react';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import type { Contradiction } from '../../types';

interface ContradictionAlertProps {
  contradictions: Contradiction[];
}

export const ContradictionAlert: React.FC<ContradictionAlertProps> = ({ contradictions }) => {
  if (contradictions.length === 0) {
    return null;
  }

  const serious = contradictions.filter((c) => c.severity === 'SERIOUS');
  const moderate = contradictions.filter((c) => c.severity === 'MODERATE');

  return (
    <div className="space-y-2">
      {/* Serious Contradictions */}
      {serious.map((c) => (
        <div
          key={c.id || c.contradiction_type}
          className="rounded border border-rose-300 bg-rose-50 p-3.5 text-rose-950 shadow-sm"
        >
          <div className="flex items-start space-x-2.5">
            <ShieldAlert className="h-4 w-4 shrink-0 text-rose-600 mt-0.5" />
            <div className="flex-1 text-xs">
              <div className="flex items-center space-x-2">
                <span className="font-bold uppercase tracking-wide text-rose-800 text-[10px] bg-rose-100 px-1.5 py-0.5 rounded">
                  SERIOUS CONTRADICTION
                </span>
                <span className="font-semibold text-rose-900">{c.contradiction_type}</span>
              </div>
              <p className="mt-1 text-rose-800 leading-relaxed">{c.description}</p>
              <p className="mt-1 text-[11px] font-medium text-rose-700">
                ⚠️ Policy guardrail: This serious conflict blocks Likely Match routing and requires manual human review.
              </p>
            </div>
          </div>
        </div>
      ))}

      {/* Moderate Warnings */}
      {moderate.map((c) => (
        <div
          key={c.id || c.contradiction_type}
          className="rounded border border-amber-300 bg-amber-50 p-3 text-amber-950"
        >
          <div className="flex items-start space-x-2.5">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
            <div className="flex-1 text-xs">
              <div className="flex items-center space-x-2">
                <span className="font-bold uppercase tracking-wide text-amber-800 text-[10px] bg-amber-100 px-1.5 py-0.5 rounded">
                  MODERATE WARNING
                </span>
                <span className="font-semibold text-amber-900">{c.contradiction_type}</span>
              </div>
              <p className="mt-1 text-amber-800">{c.description}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};
