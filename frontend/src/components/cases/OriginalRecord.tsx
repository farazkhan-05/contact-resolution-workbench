import React from 'react';
import { Building2, Mail, MapPin, Phone, User } from 'lucide-react';
import type { CaseDetail } from '../../types';

interface OriginalRecordProps {
  caseDetail: CaseDetail;
}

export const OriginalRecord: React.FC<OriginalRecordProps> = ({ caseDetail }) => {
  const fields = [
    {
      label: 'Subject Name',
      icon: User,
      raw: caseDetail.raw_name,
      normalized: caseDetail.normalized_name,
      extra:
        caseDetail.name_suffix || caseDetail.name_prefix
          ? `Prefix: ${caseDetail.name_prefix || '-'} • Suffix: ${caseDetail.name_suffix || '-'}`
          : null,
    },
    {
      label: 'Email Address',
      icon: Mail,
      raw: caseDetail.raw_email,
      normalized: caseDetail.normalized_email,
    },
    {
      label: 'Phone Number',
      icon: Phone,
      raw: caseDetail.raw_phone,
      normalized: caseDetail.normalized_phone,
    },
    {
      label: 'Employer',
      icon: Building2,
      raw: caseDetail.raw_employer,
      normalized: caseDetail.normalized_employer,
    },
    {
      label: 'Location',
      icon: MapPin,
      raw: caseDetail.raw_location,
      normalized: caseDetail.normalized_location,
    },
  ];

  return (
    <div className="rounded border border-border bg-surface p-4">
      <div className="flex items-center justify-between pb-3 border-b border-border">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
          Original Ingested Record
        </h3>
        {caseDetail.source_identifier && (
          <span className="font-mono text-[10px] text-muted">
            Ref: {caseDetail.source_identifier}
          </span>
        )}
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((field) => {
          const Icon = field.icon;
          const hasValue = Boolean(field.raw);

          return (
            <div key={field.label} className="rounded border border-border/60 bg-background/50 p-2.5">
              <div className="flex items-center space-x-1.5 text-[11px] font-medium text-muted">
                <Icon className="h-3.5 w-3.5 text-slate-400" />
                <span>{field.label}</span>
              </div>
              <div className="mt-1">
                {hasValue ? (
                  <>
                    <p className="text-xs font-semibold text-foreground break-words">{field.raw}</p>
                    {field.normalized && field.normalized !== field.raw?.toLowerCase() && (
                      <p className="mt-0.5 font-mono text-[10px] text-slate-500">
                        Normalized: {field.normalized}
                      </p>
                    )}
                    {field.extra && (
                      <p className="mt-0.5 text-[10px] text-slate-500 font-mono">{field.extra}</p>
                    )}
                  </>
                ) : (
                  <p className="text-xs italic text-muted">Not provided</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
