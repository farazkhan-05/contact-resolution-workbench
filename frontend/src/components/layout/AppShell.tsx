import React, { useRef, useState, useSyncExternalStore } from 'react';
import { ChevronDown, Download, HelpCircle, Loader2, MoreHorizontal, RefreshCw, Sparkles, Upload, UserRound, X } from 'lucide-react';
import { ProductLogo } from './ProductLogo';
import { HelpTooltip } from './HelpTooltip';
import { ActionMenu } from './ActionMenu';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { InlineFeedback } from '../ui/Feedback';
import './AppShell.css';

interface AppShellProps {
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
const compactQuery = '(max-width: 899px)';
const subscribe = (callback: () => void) => {
  const query = window.matchMedia(compactQuery);
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
};
const getCompact = () => window.matchMedia(compactQuery).matches;

export const AppShell: React.FC<AppShellProps> = ({
  activePage, onNavigate, onLoadSample, onUploadCsv, onExportCsv, onOpenAiModal, activity,
  isLoadingSample, isUploadingCsv, isExportingCsv, exportDisabled, feedback, onClearFeedback, onSignOut, children,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csvHelpTriggerRef = useRef<HTMLButtonElement>(null);
  const csvHelpCloseRef = useRef<HTMLButtonElement>(null);
  const [csvHelpOpen, setCsvHelpOpen] = useState(false);
  const compact = useSyncExternalStore(subscribe, getCompact, () => false);
  const closeCsvHelp = () => {
    setCsvHelpOpen(false);
  };
  const downloadCsvTemplate = () => {
    const template = 'case_number,full_name,source_identifier,old_email,old_phone,employer,location\r\n';
    const url = URL.createObjectURL(new Blob([template], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'case-import-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  };
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await onUploadCsv(file);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };
  const aiAction = <div className="workflow-action">
    <button type="button" className="shell-button" onClick={onOpenAiModal}><Sparkles size={14} aria-hidden="true" />AI Evidence Extraction</button>
    <HelpTooltip label="AI Evidence Extraction" text="Use AI to pull useful details from notes or documents." />
  </div>;
  const sampleAction = <button type="button" className="shell-button" onClick={() => void onLoadSample()} disabled={isLoadingSample || isUploadingCsv}>
    {isLoadingSample ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}Load Sample Cases
  </button>;
  const uploadAction = <div className="workflow-action upload-action">
    <button type="button" className="shell-button shell-button-bordered" onClick={() => fileInputRef.current?.click()} disabled={isLoadingSample || isUploadingCsv}>
      {isUploadingCsv ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Upload size={14} aria-hidden="true" />}Upload CSV
    </button>
    <button ref={csvHelpTriggerRef} type="button" className="help-trigger" aria-label="CSV format help" aria-haspopup="dialog" onClick={() => setCsvHelpOpen(true)}><HelpCircle size={14} aria-hidden="true" /></button>
  </div>;
  const exportAction = <div className="workflow-action">
    <button type="button" className="shell-button" onClick={() => void onExportCsv()} disabled={isExportingCsv || exportDisabled}>
      {isExportingCsv ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}Export Reviewed
    </button>
    <HelpTooltip label="Export Reviewed" text="Download cases that already have a review decision." />
  </div>;
  return <div className="app-shell">
    <header className="global-header">
      <div className="product-brand"><ProductLogo className="product-logo" /><p className="product-name">Contact Resolution Workbench</p></div>
      <nav aria-label="Product navigation" className="product-nav">
        <button type="button" aria-current={activePage === 'cases' ? 'page' : undefined} onClick={() => onNavigate('cases')}>Cases</button>
        <div className="sources-nav"><button type="button" aria-current={activePage === 'sources' ? 'page' : undefined} onClick={() => onNavigate('sources')}>Sources</button><HelpTooltip label="Sources" text="Manage where your records come from." /></div>
      </nav>
      <div className="account-control"><ActionMenu label="Account menu" trigger={<><UserRound size={18} aria-hidden="true" /><ChevronDown size={12} aria-hidden="true" /></>}>
        <p className="menu-label">Account</p><button type="button" className="shell-button" onClick={() => void onSignOut()}>Sign out</button>
      </ActionMenu></div>
    </header>
    <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFileChange} className="hidden" id="csv-upload-input" aria-label="Upload CSV file" />
    {activePage === 'cases' && <section className="workspace-toolbar" aria-label="Cases workspace actions">
      <h1>Cases</h1>
      <div className="workflow-actions">
        {compact ? <>{uploadAction}<ActionMenu label="More case actions" trigger={<><MoreHorizontal size={16} aria-hidden="true" /><span>More</span></>}>{aiAction}{sampleAction}{exportAction}</ActionMenu></> : <>{aiAction}{sampleAction}{uploadAction}<span className="toolbar-divider" />{exportAction}</>}
      </div>
    </section>}
    <Dialog open={csvHelpOpen} onDismiss={closeCsvHelp} labelledBy="csv-help-title" describedBy="csv-help-intro"
      initialFocusRef={csvHelpCloseRef} returnFocusRef={csvHelpTriggerRef} className="csv-help-content">
        <div className="ui-dialog-header"><h2 id="csv-help-title" className="ui-dialog-title">CSV format</h2><Button ref={csvHelpCloseRef} variant="quiet" iconOnly onClick={closeCsvHelp} aria-label="Close CSV format help"><X size={18} aria-hidden="true" /></Button></div>
        <div className="ui-dialog-body">
        <p id="csv-help-intro">Upload a CSV file with records you want to review.</p>
        <h3>Required columns</h3><p><code>case_number</code>, <code>full_name</code></p>
        <h3>Optional columns</h3><p><code>source_identifier</code>, <code>old_email</code>, <code>old_phone</code>, <code>employer</code>, <code>location</code></p>
        <p className="csv-help-limits">Up to 100 records<br />Maximum file size 256 KB</p>
        <p>If the file has an invalid row or column, nothing will be imported.</p>
        <h3>Example</h3>
        <pre className="csv-help-example"><code>{'case_number,full_name,source_identifier,old_email,old_phone,employer,location\nDEMO-001,Emre Demo Yılmaz,SRC-001,emre@demo.example,905550000101,Demo Anadolu Teknoloji,İstanbul\nDEMO-002,Leyla Demo Karaca,SRC-002,leyla@demo.example,,Mavişehir Teknoloji,İzmir'}</code></pre>
        <p className="csv-help-note">This is synthetic demo data.</p>
        </div>
        <div className="ui-dialog-footer"><Button onClick={downloadCsvTemplate}>Download CSV template</Button><Button variant="quiet" onClick={closeCsvHelp}>Close</Button></div>
    </Dialog>
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
