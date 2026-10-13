import { useRef } from 'react';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { InlineFeedback } from '../ui/Feedback';

export function CsvSubmissionRecovery({ fileName, pendingFile, onViewActivity, onCancel, onConfirm }: {
  fileName: string; pendingFile: File | null; onViewActivity: () => void; onCancel: () => void; onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return <>
    <InlineFeedback tone="warning">
      <p>CSV submission unconfirmed: {fileName}</p>
      <p>The upload may have been accepted. Check Recent activity before choosing another file. Missing activity does not prove it was rejected.</p>
      <Button onClick={onViewActivity}>Check CSV activity</Button>
    </InlineFeedback>
    <Dialog open={!!pendingFile} onDismiss={onCancel} labelledBy="csv-recovery-title" describedBy="csv-recovery-description" initialFocusRef={cancel}>
      <div className="ui-dialog-body">
        <h2 id="csv-recovery-title" className="ui-dialog-title">Submit another CSV?</h2>
        <p id="csv-recovery-description">The previous upload ({fileName}) is still unconfirmed. Submitting {pendingFile?.name} starts a new operation and may duplicate work, even if the previous upload is absent from Recent activity.</p>
        <p>This does not cancel or retry the previous upload, or confirm its outcome.</p>
        <Button onClick={onViewActivity}>Check CSV activity</Button>
      </div>
      <div className="ui-dialog-footer">
        <Button ref={cancel} onClick={onCancel}>Cancel new upload</Button>
        <Button variant="primary" onClick={onConfirm}>I understand; submit new upload</Button>
      </div>
    </Dialog>
  </>;
}
