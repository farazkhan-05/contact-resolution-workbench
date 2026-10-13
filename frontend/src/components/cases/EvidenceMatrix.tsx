import type { CandidateDetail } from '../../types';

const methodLabel = (method: string) => method === 'MISSING' ? 'Missing field'
  : method.replaceAll('_', ' ').toLowerCase().replace(/^./, value => value.toUpperCase());

export function EvidenceMatrix({ activeCandidate, aiExtracted = false }: {
  activeCandidate: CandidateDetail;
  aiExtracted?: boolean;
}) {
  return (
    <div className="case-evidence-body">
      <div className="case-evidence-context">
        <p>Candidate source: {activeCandidate.provenance_summary || activeCandidate.provider_source}</p>
        <p>Record: {activeCandidate.provider_record_id}</p>
      </div>
      {aiExtracted && <p className="case-metadata">Subject evidence: AI extracted / Unverified</p>}
      <div className="evidence-scroll">
        <table className="evidence-table">
          <caption className="sr-only">Original record and {activeCandidate.name}: field evidence and server-provided points</caption>
          <thead>
            <tr><th scope="col">Field</th><th scope="col">Original Record</th><th scope="col">Candidate Record</th><th scope="col">Evidence Explanation</th><th scope="col">Points</th></tr>
          </thead>
          <tbody>
            {activeCandidate.evidence.map(evidence => (
              <tr key={evidence.id || evidence.field_name}>
                <th scope="row">{evidence.field_name.charAt(0).toUpperCase() + evidence.field_name.slice(1)}</th>
                <td data-label="Original Record">{evidence.source_value || <span className="case-missing">Not provided</span>}</td>
                <td data-label="Candidate Record">{evidence.candidate_value || <span className="case-missing">Not provided</span>}</td>
                <td data-label="Evidence Explanation">
                  <span className="case-evidence-method">{methodLabel(evidence.match_method)}</span><p>{evidence.explanation}</p>
                </td>
                <td data-label="Points" className="case-evidence-points">{evidence.points_awarded} <span>/ {evidence.max_points}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!activeCandidate.evidence.length && <p className="case-missing">Field evidence is unavailable for this candidate.</p>}
      <div className="case-score-summary">
        <div><strong>Deterministic match score</strong><p>Evidence scores summarize deterministic field matches; they are not identity probabilities.</p></div>
        <p><strong>{activeCandidate.total_score}</strong> / 100 points</p>
      </div>
    </div>
  );
}
