import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import type { AIProvenance, SourceContext } from '../../types';

export function AIProvenanceSection({ caseId, provenance }: {
  caseId: string; provenance: AIProvenance;
}) {
  const { workspace, status } = useAuth();
  // A keyed child discards source text synchronously when Case or session changes.
  return status === 'ready' ? <SourceDisclosure key={`${caseId}:${workspace?.id}:${status}`}
    caseId={caseId} provenance={provenance} /> : null;
}

function SourceDisclosure({ caseId, provenance }: { caseId: string; provenance: AIProvenance }) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<SourceContext | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open || !provenance.source_context_available) return;
    const controller = new AbortController();
    let active = true;
    setSource(null); setFailed(false);
    void api.getSourceContext(caseId, controller.signal).then((next) => {
      if (active) setSource(next);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; controller.abort(); };
  }, [caseId, open, provenance.source_context_available]);
  return <section aria-label="AI extracted evidence" className="rounded border border-border bg-surface p-4 space-y-2 text-xs">
    <h3 className="font-semibold">AI extracted evidence · Unverified</h3>
    <p>These details were extracted by AI and have not been verified.</p>
    {provenance.job_title && <div><p>Role: {provenance.job_title}</p>
      <p className="text-muted">Role is shown for context and is not used in the match score.</p></div>}
    {provenance.source_context_available ? <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer">Show source note</summary>
      {open && (failed ? <p role="alert">Source context unavailable.</p> : source ?
        <pre className="mt-2 whitespace-pre-wrap break-words font-sans">{source.original_text}</pre> :
        <p role="status">Loading source note...</p>)}
    </details> : <p>Source context unavailable.</p>}
  </section>;
}
