import type { CandidateDetail } from '../../types';
import { StatusIndicator } from '../ui/Feedback';

interface CandidateListProps {
  candidates: CandidateDetail[];
  selectedCandidateId: string | null;
  onSelectCandidate: (candidateId: string) => void;
}
export function CandidateList({ candidates, selectedCandidateId, onSelectCandidate }: CandidateListProps) {
  if (!candidates.length) return (
    <section className="case-candidates-empty">
      <h3>No matching candidates found</h3>
      <p>No candidate records are available for comparison.</p>
    </section>
  );
  return (
    <div className="candidate-grid" role="group" aria-label="Choose candidate">
      {candidates.map((candidate, index) => (
        <button key={candidate.id} type="button" className="case-candidate-option"
          aria-pressed={candidate.id === selectedCandidateId} onClick={() => onSelectCandidate(candidate.id)}>
          <span className="case-candidate-top">
            <span className="case-metadata">Candidate {index < 26 ? String.fromCharCode(65 + index) : index + 1}</span>
            {candidate.id === selectedCandidateId && <span className="case-active">Active</span>}
          </span>
          <span className="case-candidate-body">
            <span>
              <strong>{candidate.name}</strong>
              <span className="case-row-context">
                {[candidate.employer, candidate.location].filter(Boolean).join(' · ') || candidate.provider_source}
              </span>
            </span>
            <span className="case-candidate-score"><strong>{candidate.total_score}</strong><span>points / 100</span></span>
          </span>
          <span className="case-candidate-bottom">
            <span className="case-metadata">{candidate.provider_source}</span>
            {candidate.has_serious_contradiction && <StatusIndicator tone="error">Serious conflict</StatusIndicator>}
          </span>
        </button>
      ))}
    </div>
  );
}
