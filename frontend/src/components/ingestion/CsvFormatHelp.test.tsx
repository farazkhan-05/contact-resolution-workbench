import { createRef } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CsvFormatHelp } from './CsvFormatHelp';

afterEach(cleanup);

it('explains immediate file submission and unknown-outcome guidance without opening a chooser or displaying invented counts', () => {
  render(<CsvFormatHelp open submitting={false} onClose={vi.fn()} returnFocusRef={createRef()} />);
  expect(screen.getByText(/Choosing a file starts its submission/)).toBeTruthy();
  expect(screen.getByText(/If the outcome is unknown/)).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('progressbar')).toBeNull();
  const required = screen.getByRole('region', { name: 'Required columns' });
  expect(within(required).getByText('case_number')).toBeTruthy();
  expect(within(required).getByText('full_name')).toBeTruthy();
  fireEvent.click(screen.getByText('CSV example'));
  expect(screen.getByText('CSV example').closest('details')?.open).toBe(true);
});

it('announces only pending confirmation while submitting and allows closing help without canceling the upload', () => {
  const close = vi.fn(); const returnFocusRef = createRef<HTMLButtonElement>();
  const view = render(<CsvFormatHelp open submitting onClose={close} returnFocusRef={returnFocusRef} />);
  expect(screen.getByRole('status').textContent).toContain('Waiting for confirmation');
  expect(screen.getByRole('status').textContent).toContain('does not cancel');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(close).toHaveBeenCalledTimes(1);
  view.rerender(<CsvFormatHelp open submitting={false} onClose={close} returnFocusRef={returnFocusRef} />);
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByText(/records? imported\./)).toBeNull();
});
