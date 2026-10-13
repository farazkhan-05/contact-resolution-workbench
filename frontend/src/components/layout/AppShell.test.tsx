import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';

const props = () => ({ activePage: 'cases' as const, workspaceName: 'Synthetic review workspace', onNavigate: vi.fn(),
  onLoadSample: vi.fn(async () => {}), onUploadCsv: vi.fn(async () => {}), onExportCsv: vi.fn(async () => {}),
  onOpenAiModal: vi.fn(), isLoadingSample: false, isUploadingCsv: false, isExportingCsv: false, exportDisabled: false,
  feedback: null, onClearFeedback: vi.fn(), onSignOut: vi.fn(async () => {}), activity: <button>Recent activity</button>, children: <p>Workspace fixture</p>,
});
afterEach(cleanup);

describe('application shell presentation', () => {
  it('keeps two primary destinations and consistent page headings with real workspace context', () => {
    const actions = props(); const view = render(<AppShell {...actions} />);
    const nav = screen.getByRole('navigation', { name: 'Product navigation' });
    expect(within(nav).getByRole('button', { name: 'Cases' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(within(nav).getByRole('button', { name: 'Sources' }));
    expect(actions.onNavigate).toHaveBeenCalledWith('sources');
    view.rerender(<AppShell {...actions} activePage="sources" />);
    expect(screen.getByRole('heading', { name: 'Sources', level: 1 })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: 'Sources' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('Synthetic review workspace')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Recent activity' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Upload CSV' })).toBeNull();
  });

  it('retains action handlers, the CSV chooser, help, and template access', () => {
    const actions = props(); render(<AppShell {...actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Evidence Extraction' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load Sample Cases' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export Reviewed' }));
    expect(actions.onOpenAiModal).toHaveBeenCalledTimes(1);
    expect(actions.onLoadSample).toHaveBeenCalledTimes(1);
    expect(actions.onExportCsv).toHaveBeenCalledTimes(1);
    const chooser = screen.getByLabelText('Upload CSV file'); const click = vi.spyOn(chooser, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Upload CSV' })); expect(click).toHaveBeenCalledTimes(1);
    const file = new File(['case_number,full_name\nSYN-1,Example Person'], 'synthetic.csv', { type: 'text/csv' });
    fireEvent.change(chooser, { target: { files: [file] } }); expect(actions.onUploadCsv).toHaveBeenCalledWith(file);
    fireEvent.click(screen.getByRole('button', { name: 'CSV format help' }));
    expect(screen.getByRole('dialog', { name: 'CSV format' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download CSV template' })).toBeTruthy();
  });

  it('keeps loading and export availability restrictions', () => {
    render(<AppShell {...props()} isUploadingCsv exportDisabled />);
    expect((screen.getByRole('button', { name: 'Upload CSV' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Load Sample Cases' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Export Reviewed' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
