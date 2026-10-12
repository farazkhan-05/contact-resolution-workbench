import React, { useRef, useState, useSyncExternalStore } from 'react';
import { ChevronDown, Download, HelpCircle, MoreHorizontal, RefreshCw, Sparkles, Upload, UserRound, X } from 'lucide-react';
import { ProductLogo } from './ProductLogo';
import { HelpTooltip } from './HelpTooltip';
import { ActionMenu } from './ActionMenu';
import { CsvFormatHelp } from '../ingestion/CsvFormatHelp';
import { Button } from '../ui/Button';
import { InlineFeedback } from '../ui/Feedback';
import './AppShell.css';

interface AppShellProps {
  workspaceName?: string;
  activePage: 'cases' | 'sources';
  onNavigate: (page: 'cases' | 'sources') => void;
  onLoadSample: () => Promise<void>;
  onUploadCsv: (file: File) => Promise<void>;
  onExportCsv: () => Promise<void>;
  onOpenAiModal: () => void;
  activity?: React.ReactNode;
  isLoadingSample: boolean;
  isUploadingCsv: boolean;
  isExportingCsv: boolean;
  exportDisabled: boolean;
  feedback: { type: 'success' | 'error' | 'info'; message: string; action?: { label: string; run: () => void } } | null;
  onClearFeedback: () => void;
  onSignOut: () => Promise<void>;
  children: React.ReactNode;
}
const compactQuery = '(max-width: 1199px)';
const subscribe = (callback: () => void) => {
  const query = window.matchMedia(compactQuery);
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
};
const getCompact = () => window.matchMedia(compactQuery).matches;

export const AppShell: React.FC<AppShellProps> = ({
  workspaceName,
  activePage, onNavigate, onLoadSample, onUploadCsv, onExportCsv, onOpenAiModal, activity,
  isLoadingSample, isUploadingCsv, isExportingCsv, exportDisabled, feedback, onClearFeedback, onSignOut, children,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csvHelpTriggerRef = useRef<HTMLButtonElement>(null);
  const [csvHelpOpen, setCsvHelpOpen] = useState(false);
  const compact = useSyncExternalStore(subscribe, getCompact, () => false);
  const closeCsvHelp = () => {
    setCsvHelpOpen(false);
  };
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await onUploadCsv(file);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };
  const aiAction = <div className="workflow-action">
    <Button variant="quiet" className="shell-button" onClick={onOpenAiModal}><Sparkles size={16} aria-hidden="true" />AI Evidence Extraction</Button>
    <HelpTooltip label="AI Evidence Extraction" text="Use AI to pull useful details from notes or documents." />
  </div>;
  const sampleAction = <Button variant="quiet" className="shell-button" onClick={() => void onLoadSample()} disabled={isLoadingSample || isUploadingCsv} loading={isLoadingSample}>
    {!isLoadingSample && <RefreshCw size={16} aria-hidden="true" />}Load Sample Cases
  </Button>;
  const uploadAction = <div className="workflow-action upload-action">
    <Button className="shell-button shell-button-bordered" onClick={() => fileInputRef.current?.click()} disabled={isLoadingSample || isUploadingCsv} loading={isUploadingCsv}>
      {!isUploadingCsv && <Upload size={16} aria-hidden="true" />}Upload CSV
    </Button>
    <button ref={csvHelpTriggerRef} type="button" className="help-trigger" aria-label="CSV format help" aria-haspopup="dialog" onClick={() => setCsvHelpOpen(true)}><HelpCircle size={14} aria-hidden="true" /></button>
  </div>;
  const exportAction = <div className="workflow-action">
    <Button variant="quiet" className="shell-button" onClick={() => void onExportCsv()} disabled={isExportingCsv || exportDisabled} loading={isExportingCsv}>
      {!isExportingCsv && <Download size={16} aria-hidden="true" />}Export Reviewed
    </Button>
    <HelpTooltip label="Export Reviewed" text="Download cases that already have a review decision." />
  </div>;
  return <div className="app-shell">
    <header className="global-header">
      <div className="product-brand"><ProductLogo className="product-logo" /><p className="product-name">Contact Resolution Workbench</p></div>
      <nav aria-label="Product navigation" className="product-nav">
        <button type="button" aria-current={activePage === 'cases' ? 'page' : undefined} onClick={() => onNavigate('cases')}>Cases</button>
        <div className="sources-nav"><button type="button" aria-current={activePage === 'sources' ? 'page' : undefined} onClick={() => onNavigate('sources')}>Sources</button><HelpTooltip label="Sources" text="Manage where your records come from." /></div>
      </nav>
      <div className="account-control">
        {workspaceName && <p className="workspace-context"><span>Workspace</span>{workspaceName}</p>}
        <ActionMenu label="Account menu" trigger={<><UserRound size={18} aria-hidden="true" /><span>Account</span><ChevronDown size={14} aria-hidden="true" /></>}>
        <p className="menu-label">{workspaceName || 'Account'}</p><Button variant="quiet" className="shell-button" onClick={() => void onSignOut()}>Sign out</Button>
      </ActionMenu></div>
    </header>
    <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFileChange} className="hidden" id="csv-upload-input" aria-label="Upload CSV file" />
    <section className="workspace-toolbar" aria-label={`${activePage === 'cases' ? 'Cases' : 'Sources'} workspace actions`}>
      <h1>{activePage === 'cases' ? 'Cases' : 'Sources'}</h1>
      {activePage === 'cases' && <div className="workflow-actions">
        {compact ? <>{uploadAction}<ActionMenu label="More case actions" trigger={<><MoreHorizontal size={16} aria-hidden="true" /><span>More</span></>}><p className="menu-label">Add records</p>{aiAction}{sampleAction}<p className="menu-label">Review output</p>{exportAction}</ActionMenu></> : <>{aiAction}{sampleAction}{uploadAction}<span className="toolbar-divider" />{exportAction}</>}
      </div>}
    </section>
    <CsvFormatHelp open={csvHelpOpen} onClose={closeCsvHelp} submitting={isUploadingCsv} returnFocusRef={csvHelpTriggerRef} />
      {/* Inline Feedback Banner */}
      {feedback && (
        <InlineFeedback tone={feedback.type} className="ui-feedback-row">
          <div className="ui-feedback-content">
            <span className="font-medium">{feedback.message}</span>
            {feedback.action && (
              <Button
                onClick={feedback.action.run}
              >
                {feedback.action.label}
              </Button>
            )}
          </div>
          <Button variant="quiet" iconOnly
            onClick={onClearFeedback}
            aria-label="Dismiss message"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </InlineFeedback>
      )}

    {activity}
    <main className="shell-workspace">{children}</main>
    <footer className="environment-note">Synthetic demo data only</footer>
  </div>;
};
