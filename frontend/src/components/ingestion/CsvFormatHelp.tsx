import { useRef, type RefObject } from 'react';
import { X } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { InlineFeedback } from '../ui/Feedback';
import './Ingestion.css';

export function CsvFormatHelp({ open, onClose, submitting, returnFocusRef }: {
  open: boolean; onClose: () => void; submitting: boolean; returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const downloadTemplate = () => {
    const template = 'case_number,full_name,source_identifier,old_email,old_phone,employer,location\r\n';
    const url = URL.createObjectURL(new Blob([template], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'case-import-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  };
  return <Dialog open={open} onDismiss={onClose} labelledBy="csv-help-title" describedBy="csv-help-intro"
    initialFocusRef={closeButton} returnFocusRef={returnFocusRef} className="csv-ingestion">
    <div className="ui-dialog-header"><div><p className="ingestion-eyebrow">Add records</p><h2 id="csv-help-title" className="ui-dialog-title">CSV format</h2></div>
      <Button ref={closeButton} variant="quiet" iconOnly onClick={onClose} aria-label="Close CSV format help"><X size={18} aria-hidden="true" /></Button></div>
    <div className="ui-dialog-body">
      <p id="csv-help-intro">Upload a CSV file with records you want to review.</p>
      <p className="ingestion-muted">Use Upload CSV in the workspace to choose a file. Choosing a file starts its submission.</p>
      {submitting && <InlineFeedback>Submitting your CSV. Waiting for confirmation. Closing this help does not cancel the submission.</InlineFeedback>}
      <div className="csv-guidance">
        <section aria-labelledby="csv-required"><h3 id="csv-required">Required columns</h3><ul className="csv-column-list"><li><code>case_number</code></li><li><code>full_name</code></li></ul></section>
        <section aria-labelledby="csv-optional"><h3 id="csv-optional">Optional columns</h3><ul className="csv-column-list">{['source_identifier', 'old_email', 'old_phone', 'employer', 'location'].map(column => <li key={column}><code>{column}</code></li>)}</ul></section>
        <section aria-labelledby="csv-validation"><h3 id="csv-validation">Limits and validation</h3><div className="csv-help-limits"><p>Up to 100 records</p><p>Maximum file size 256 KB</p></div>
          <p>If the file has an invalid row or column, nothing will be imported.</p></section>
      </div>
      <p className="ingestion-muted">After submission, workspace feedback and Recent activity show the import result. If the outcome is unknown, check existing activity before uploading again.</p>
      <details><summary>CSV example</summary><p className="ingestion-muted">This is synthetic demo data.</p>
        <pre className="csv-help-example"><code>{'case_number,full_name,source_identifier,old_email,old_phone,employer,location\nDEMO-001,Emre Demo Yılmaz,SRC-001,emre@demo.example,905550000101,Demo Anadolu Teknoloji,İstanbul\nDEMO-002,Leyla Demo Karaca,SRC-002,leyla@demo.example,,Mavişehir Teknoloji,İzmir'}</code></pre>
      </details>
    </div>
    <div className="ui-dialog-footer"><Button onClick={downloadTemplate}>Download CSV template</Button><Button variant="quiet" onClick={onClose}>Close</Button></div>
  </Dialog>;
}
