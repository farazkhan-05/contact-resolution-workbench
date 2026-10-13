import type { Contradiction } from '../../types';
import { AlertTriangle } from 'lucide-react';

export function ContradictionAlert({ contradictions, seriousFlag = false, candidateName }: {
  contradictions: Contradiction[];
  seriousFlag?: boolean;
  candidateName?: string;
}) {
  if (!contradictions.length && !seriousFlag) return null;
  return (
    <section className="case-conflicts" aria-label="Selected candidate conflicts">
      {contradictions.map(conflict => (
        <div key={conflict.id || conflict.contradiction_type}
          className={`case-conflict case-conflict-${conflict.severity === 'SERIOUS' ? 'serious' : 'moderate'}`}>
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <p className="case-conflict-severity">{conflict.severity === 'SERIOUS' ? 'Serious conflict' : 'Moderate warning'}</p>
            {candidateName && <p>Selected candidate: {candidateName}</p>}
            <h3>{conflict.contradiction_type.replaceAll('_', ' ').toLowerCase().replace(/^./, value => value.toUpperCase())}</h3>
            <p>{conflict.description}</p>
            <p className="case-conflict-guidance">Review the conflicting evidence before deciding.</p>
          </div>
        </div>
      ))}
      {seriousFlag && !contradictions.some(conflict => conflict.severity === 'SERIOUS') && (
        <div className="case-conflict case-conflict-serious">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <h3>Serious conflict reported for this candidate</h3>
            {candidateName && <p>Selected candidate: {candidateName}</p>}
            <p>The conflict explanation is not available. Review the evidence before deciding.</p>
          </div>
        </div>
      )}
    </section>
  );
}
