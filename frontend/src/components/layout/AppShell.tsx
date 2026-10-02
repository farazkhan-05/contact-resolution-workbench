import React, { useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  HelpCircle,
  Layers,
  Loader2,
  RefreshCw,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';

interface AppShellProps {
  onNavigate: () => void;
  navigationLabel: string;
  onLoadSample: () => Promise<void>;
  onUploadCsv: (file: File) => Promise<void>;
  onExportCsv: () => Promise<void>;
  onOpenAiModal: () => void;
  onRetry?: () => void;
  isLoadingSample: boolean;
  isUploadingCsv: boolean;
  isExportingCsv: boolean;
  feedback: { type: 'success' | 'error' | 'info'; message: string } | null;
  onClearFeedback: () => void;
  onSignOut: () => Promise<void>;
  children: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({
  onNavigate,
  navigationLabel,
  onLoadSample,
  onUploadCsv,
  onExportCsv,
  onOpenAiModal,
  onRetry,
  isLoadingSample,
  isUploadingCsv,
  isExportingCsv,
  feedback,
  onClearFeedback,
  onSignOut,
  children,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showCsvHelp, setShowCsvHelp] = useState(false);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await onUploadCsv(file);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* Top Header */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface px-4 sm:px-6">
        <div className="flex items-center space-x-3">
          <div className="flex h-8 w-8 items-center justify-center rounded border border-border bg-surface-muted text-accent">
            <Layers className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h1 className="text-sm font-semibold tracking-tight text-foreground">
                Contact Resolution Workbench
              </h1>
              <span className="inline-flex items-center rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-muted">
                Synthetic Demo Data Only
              </span>
            </div>
          </div>
        </div>

        <button className="rounded border border-border px-3 py-1.5 text-xs" onClick={onNavigate}>{navigationLabel}</button>
        {/* Global Actions */}
        <div className="flex items-center space-x-2 sm:space-x-3">
          <button
            type="button"
            onClick={() => void onSignOut()}
            className="text-xs font-medium text-muted hover:text-foreground"
          >
            Sign out
          </button>
          <button
            type="button"
            onClick={onOpenAiModal}
            className="inline-flex items-center space-x-1.5 rounded border border-accent/40 bg-accent-muted/30 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent-muted/60"
            title="Extract structured profile from messy provider evidence using Gemini"
          >
            <Sparkles className="h-3.5 w-3.5 text-accent" />
            <span className="hidden sm:inline">Try AI Evidence Extraction</span>
            <span className="sm:hidden">AI Extract</span>
          </button>

          <button
            type="button"
            onClick={onLoadSample}
            disabled={isLoadingSample || isUploadingCsv}
            className="inline-flex items-center space-x-1.5 rounded border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
            title="Load 8 synthetic benchmark test cases"
          >
            {isLoadingSample ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 text-muted" />
            )}
            <span className="hidden sm:inline">Load Sample Cases</span>
            <span className="sm:hidden">Samples</span>
          </button>

          <div className="relative">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              onChange={handleFileChange}
              className="hidden"
              id="csv-upload-input"
            />
            <div className="inline-flex rounded border border-border bg-surface">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoadingSample || isUploadingCsv}
                className="inline-flex items-center space-x-1.5 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isUploadingCsv ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />
                ) : (
                  <Upload className="h-3.5 w-3.5 text-muted" />
                )}
                <span className="hidden sm:inline">Upload CSV</span>
                <span className="sm:hidden">Upload</span>
              </button>
              <button
                type="button"
                onClick={() => setShowCsvHelp(!showCsvHelp)}
                className="border-l border-border px-1.5 py-1.5 text-muted hover:bg-surface-muted hover:text-foreground"
                title="View accepted CSV schema"
                aria-label="CSV Schema Information"
              >
                <HelpCircle className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* CSV Schema Popover */}
            {showCsvHelp && (
              <div className="absolute right-0 top-full z-50 mt-1.5 w-80 rounded border border-border bg-surface p-3 shadow-lg">
                <div className="flex items-center justify-between pb-1.5 border-b border-border">
                  <div className="flex items-center space-x-1.5 text-xs font-semibold text-foreground">
                    <FileSpreadsheet className="h-3.5 w-3.5 text-accent" />
                    <span>Accepted CSV Format</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowCsvHelp(false)}
                    className="text-muted hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-2 space-y-2 text-[11px] text-muted">
                  <div>
                    <span className="font-medium text-foreground">Required Headers:</span>
                    <p className="font-mono text-[10px] text-slate-700">case_number, full_name</p>
                  </div>
                  <div>
                    <span className="font-medium text-foreground">Optional Headers:</span>
                    <p className="font-mono text-[10px] text-slate-700">
                      source_identifier, old_email, old_phone, employer, location
                    </p>
                  </div>
                  <p className="text-[10px] text-slate-500 italic">
                    Maximum 100 rows per batch. Validates entire file before persisting.
                  </p>
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={onExportCsv}
            disabled={isExportingCsv}
            className="inline-flex items-center space-x-1.5 rounded border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
            title="Download reviewed cases as CSV"
          >
            {isExportingCsv ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />
            ) : (
              <Download className="h-3.5 w-3.5 text-muted" />
            )}
            <span className="hidden sm:inline">Export Reviewed</span>
            <span className="sm:hidden">Export</span>
          </button>
        </div>
      </header>

      {/* Inline Feedback Banner */}
      {feedback && (
        <div
          className={`flex shrink-0 items-center justify-between border-b px-4 py-2 text-xs transition-colors ${
            feedback.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : feedback.type === 'error'
              ? 'border-rose-200 bg-rose-50 text-rose-900'
              : 'border-blue-200 bg-blue-50 text-blue-900'
          }`}
          role="alert"
        >
          <div className="flex items-center space-x-2">
            {feedback.type === 'success' && <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />}
            {feedback.type === 'error' && <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" />}
            {feedback.type === 'info' && <HelpCircle className="h-4 w-4 shrink-0 text-blue-600" />}
            <span className="font-medium">{feedback.message}</span>
            {feedback.type === 'error' && onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="ml-2 rounded border border-rose-300 bg-white/70 px-2 py-0.5 text-[11px] font-semibold text-rose-800 hover:bg-white"
              >
                Retry
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={onClearFeedback}
            className="rounded p-0.5 hover:bg-black/5"
            aria-label="Dismiss message"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Main Workspace Area */}
      <main className="flex flex-1 overflow-hidden">{children}</main>
    </div>
  );
};
