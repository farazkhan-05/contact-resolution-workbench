import type { CaseDetail } from '../../types';

export function OriginalRecord({ caseDetail }: { caseDetail: CaseDetail }) {
  const fields = [
    { label: 'Name', raw: caseDetail.raw_name, normalized: caseDetail.normalized_name },
    { label: 'Email', raw: caseDetail.raw_email, normalized: caseDetail.normalized_email },
    { label: 'Phone', raw: caseDetail.raw_phone, normalized: caseDetail.normalized_phone },
    { label: 'Employer', raw: caseDetail.raw_employer, normalized: caseDetail.normalized_employer },
    { label: 'Location', raw: caseDetail.raw_location, normalized: caseDetail.normalized_location },
  ];
  return <section className="case-original" aria-labelledby="case-original-heading">
    <div className="case-section-heading"><h3 id="case-original-heading">Original ingested record</h3>{caseDetail.ai_provenance && <span className="case-metadata">AI extracted / Unverified</span>}</div>
    <dl className="record-fields">{fields.map(field => <div key={field.label}><dt>{field.label}</dt><dd>{field.raw || <span className="case-missing">Not provided</span>}
      {field.raw && field.normalized && field.normalized !== field.raw.toLowerCase() && <span className="case-normalized">Normalized: {field.normalized}</span>}
      {field.label === 'Name' && (caseDetail.name_prefix || caseDetail.name_suffix) && <span className="case-normalized">Prefix: {caseDetail.name_prefix || 'Not provided'} · Suffix: {caseDetail.name_suffix || 'Not provided'}</span>}
    </dd></div>)}</dl>
  </section>;
}
