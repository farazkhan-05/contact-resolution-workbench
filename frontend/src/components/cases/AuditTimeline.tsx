import React, { useState } from 'react';
import { ChevronDown, ChevronUp, History, User } from 'lucide-react';
import type { AuditEvent } from '../../types';

interface AuditTimelineProps {
  auditLogs: AuditEvent[];
}

export const AuditTimeline: React.FC<AuditTimelineProps> = ({ auditLogs }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const getEventLabel = (eventType: string) => {
    switch (eventType) {
      case 'CASE_INGESTED':
        return 'Case ingested';
      case 'SCORED_AND_ROUTED':
        return 'Evidence scored and routed';
      case 'DECISION_RECORDED':
        return 'Reviewer decision recorded';
      case 'EXPORTED':
        return 'Resolution exported';
      default:
        return eventType;
    }
  };

  return (
    <div className="rounded border border-border bg-surface p-4">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded p-1"
        aria-expanded={isExpanded}
      >
        <div className="flex items-center space-x-2">
          <History className="h-3.5 w-3.5 text-muted" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
            Activity & Event History ({auditLogs.length})
          </h3>
        </div>
        <div className="flex items-center space-x-1 text-xs text-muted">
          <span>{isExpanded ? 'Collapse' : 'Expand'}</span>
          {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </div>
      </button>

      {isExpanded && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {auditLogs.map((log) => {
            const formattedTime = new Date(log.created_at).toLocaleString();

            const renderPayloadDetails = () => {
              if (log.event_type === 'DECISION_RECORDED') {
                const dec = String(log.payload.decision || '');
                const prev = String(log.payload.previous_decision || '');
                const hasNote = Boolean(log.payload.has_note);
                return (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-700">
                    <span>
                      <strong className="font-semibold text-foreground">Decision:</strong>{' '}
                      <span className="font-mono font-medium text-slate-900">{dec.replace('_', ' ')}</span>
                    </span>
                    {prev && prev !== 'null' && (
                      <span className="text-muted">
                        (Previous: <span className="font-mono">{prev.replace('_', ' ')}</span>)
                      </span>
                    )}
                    {hasNote && (
                      <span className="inline-flex rounded bg-surface-muted px-1.5 py-0.2 text-[10px] font-medium text-slate-700 border border-border">
                        Includes Note
                      </span>
                    )}
                  </div>
                );
              }

              if (log.event_type === 'CASE_INGESTED') {
                const src = String(log.payload.source ?? log.payload.source_type ?? 'system');
                return (
                  <div className="text-[11px] text-slate-700">
                    <span className="text-muted">Source:</span>{' '}
                    <span className="font-mono text-slate-900">{src}</span>
                  </div>
                );
              }

              if (log.event_type === 'SCORED_AND_ROUTED') {
                const candidates = log.payload.candidate_count ?? '-';
                const status = String(log.payload.routing_status || '');
                return (
                  <div className="flex flex-wrap items-center gap-x-3 text-[11px] text-slate-700">
                    <span>
                      <span className="text-muted">Candidates:</span>{' '}
                      <span className="font-mono font-medium">{String(candidates)}</span>
                    </span>
                    <span>
                      <span className="text-muted">Routing:</span>{' '}
                      <span className="font-mono font-medium">{status.replace('_', ' ')}</span>
                    </span>
                  </div>
                );
              }

              return (
                <div className="text-[11px] text-slate-600 flex flex-wrap gap-x-3 gap-y-0.5 font-mono">
                  {Object.entries(log.payload).map(([k, v]) => (
                    <span key={k}>
                      <span className="text-muted">{k}:</span> {String(v)}
                    </span>
                  ))}
                </div>
              );
            };

            return (
              <div
                key={log.id}
                className="flex items-start justify-between rounded border border-border/60 bg-background/60 p-2.5 text-xs"
              >
                <div className="space-y-1">
                  <div className="flex items-center space-x-2">
                    <span className="font-semibold text-foreground">
                      {getEventLabel(log.event_type)}
                    </span>
                    <span className="inline-flex items-center space-x-0.5 rounded bg-surface-muted px-1.5 py-0.5 text-[10px] text-muted border border-border">
                      <User className="h-2.5 w-2.5" />
                      <span>{log.actor}</span>
                    </span>
                  </div>

                  {renderPayloadDetails()}
                </div>

                <span className="text-[10px] text-slate-400 whitespace-nowrap font-mono">
                  {formattedTime}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
