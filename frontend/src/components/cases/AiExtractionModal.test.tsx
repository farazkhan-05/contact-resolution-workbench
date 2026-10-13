import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../api/client';
import { syntheticJob } from '../../test-support/jobs';
import type { Job } from '../../types';
import { AiExtractionModal } from './AiExtractionModal';

vi.mock('../../api/client', async (original) => {
  const actual = await original<typeof import('../../api/client')>();
  return { ...actual, api: { ...actual.api, ingestUnstructured: vi.fn(), getJob: vi.fn() } };
});

afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

const submit = () => act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Extract evidence' })); });

it('labels the source note and unverified evidence, with no Case link or action for empty input', () => {
  render(<AiExtractionModal isOpen onClose={vi.fn()} onCaseCreated={vi.fn(async () => {})} />);
  const input = screen.getByRole('textbox', { name: 'Source note' });
  expect(input.getAttribute('aria-describedby')).toBeTruthy();
  expect(screen.getByText(/Extracted evidence is unverified/)).toBeTruthy();
  fireEvent.change(input, { target: { value: '   ' } });
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Extract evidence' }).disabled).toBe(true);
  expect(screen.queryByRole('link')).toBeNull();
  expect(api.ingestUnstructured).not.toHaveBeenCalled();
});

it('announces pending acknowledgement without claiming accepted work or allowing dismissal or reset', async () => {
  let accept!: (job: Job) => void;
  vi.mocked(api.ingestUnstructured).mockReturnValue(new Promise(resolve => { accept = resolve; }));
  vi.mocked(api.getJob).mockResolvedValue(syntheticJob());
  const close = vi.fn();
  render(<AiExtractionModal isOpen onClose={close} onCaseCreated={vi.fn(async () => {})} />);
  await submit();
  expect(screen.getByRole('status').textContent).toContain('Waiting for confirmation');
  expect(screen.queryByText('Extraction accepted')).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Reset to example' }).disabled).toBe(true);
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
  expect(close).not.toHaveBeenCalled();
  await act(async () => accept(syntheticJob()));
  expect(screen.getByText('Extraction accepted')).toBeTruthy();
  expect(screen.queryByText('Completed')).toBeNull();
  expect(api.ingestUnstructured).toHaveBeenCalledTimes(1);
});

it('keeps an unknown acknowledgement distinct from input rejection across close and reopen', async () => {
  vi.mocked(api.ingestUnstructured).mockRejectedValue(Error('Synthetic acknowledgement lost'));
  const props = { onClose: vi.fn(), onCaseCreated: vi.fn(async () => {}) };
  const view = render(<AiExtractionModal isOpen {...props} />);
  await submit();
  expect(screen.getByRole('alert').textContent).toContain('Submission outcome unknown');
  expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBeNull();
  expect(screen.queryByText('Input was not accepted')).toBeNull();
  view.rerender(<AiExtractionModal isOpen={false} {...props} />);
  view.rerender(<AiExtractionModal isOpen {...props} />);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Extract evidence' }).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Extract evidence' }));
  expect(api.ingestUnstructured).toHaveBeenCalledTimes(1);
  expect(props.onCaseCreated).not.toHaveBeenCalled();
  expect(screen.queryByRole('link')).toBeNull();
});

it('associates a definite validation rejection with the editable note and requires explicit resubmission', async () => {
  vi.mocked(api.ingestUnstructured).mockRejectedValue(new ApiError(422, 'Synthetic input rejection'));
  render(<AiExtractionModal isOpen onClose={vi.fn()} onCaseCreated={vi.fn(async () => {})} />);
  await submit();
  const input = screen.getByRole('textbox');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(input.getAttribute('aria-errormessage')).toBe('ai-submission-feedback');
  expect(screen.getByRole('alert').textContent).toContain('Input was not accepted');
  fireEvent.change(input, { target: { value: 'Corrected synthetic note' } });
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Extract evidence' }).disabled).toBe(false);
  expect(api.ingestUnstructured).toHaveBeenCalledTimes(1);
});

it('shows the same accepted Job reference after reopening without fabricating completion or a Case link', async () => {
  vi.mocked(api.ingestUnstructured).mockResolvedValue(syntheticJob({ id: 'durable-extraction', status: 'PENDING' }));
  vi.mocked(api.getJob).mockResolvedValue(syntheticJob({ id: 'durable-extraction', status: 'RUNNING', total_rows: 4, processed_rows: 2 }));
  const props = { onClose: vi.fn(), onCaseCreated: vi.fn(async () => {}) };
  const view = render(<AiExtractionModal isOpen {...props} />); await submit();
  const result = screen.getByRole('region', { name: 'Extraction Job result' });
  expect(within(result).getByText('durable-extraction')).toBeTruthy();
  expect(within(result).getByText('Records processed: 2 of 4.')).toBeTruthy();
  expect(screen.queryByText('Completed')).toBeNull();
  view.rerender(<AiExtractionModal isOpen={false} {...props} />);
  await act(async () => view.rerender(<AiExtractionModal isOpen {...props} />));
  expect(screen.getByText('durable-extraction')).toBeTruthy();
  expect(screen.getByText(/does not cancel accepted work/)).toBeTruthy();
  expect(api.ingestUnstructured).toHaveBeenCalledTimes(1);
  expect(props.onCaseCreated).not.toHaveBeenCalled();
  expect(screen.queryByRole('link')).toBeNull();
});

it('labels last reported counts on read failure and recovers actual completed/rejected counts with reads only', async () => {
  vi.mocked(api.ingestUnstructured).mockResolvedValue(syntheticJob({ total_rows: 2 }));
  vi.mocked(api.getJob).mockRejectedValueOnce(Error('Synthetic status unavailable')).mockResolvedValue(syntheticJob({ status: 'SUCCEEDED', total_rows: 2, processed_rows: 2, successful_rows: 1, rejected_rows: 1 }));
  const created = vi.fn(async () => {});
  render(<AiExtractionModal isOpen onClose={vi.fn()} onCaseCreated={created} />); await submit();
  expect(screen.getByText('Last reported records: 0 of 2.')).toBeTruthy();
  expect(screen.queryByText('Try again')).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check Job status' })); });
  expect(screen.getByText('Records processed: 2 of 2. Rejected: 1.')).toBeTruthy();
  expect(screen.getByText(/1 record imported/)).toBeTruthy();
  expect(created).toHaveBeenCalledTimes(1);
  expect(api.ingestUnstructured).toHaveBeenCalledTimes(1);
});

it.each([
  ['RATE_LIMITED', 'Evidence extraction is busy right now. Please try again shortly.'],
  ['PROVIDER_TIMEOUT', 'Evidence extraction is temporarily unavailable. Please try again.'],
  ['INVALID_EXTRACTION', 'No useful contact evidence was found in this text.'],
])('shows safe recovery text for %s', async (failure_code, failure_message) => {
  vi.useFakeTimers();
  vi.mocked(api.ingestUnstructured).mockResolvedValue({ id: 'synthetic-job', status: 'PENDING' } as Job);
  vi.mocked(api.getJob).mockResolvedValue({ id: 'synthetic-job', status: 'FAILED', failure_code, failure_message } as Job);
  const created = vi.fn();
  render(<AiExtractionModal isOpen onClose={vi.fn()} onCaseCreated={created} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Extract evidence' })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.getByText('AI evidence extraction failed.')).toBeTruthy();
  expect(screen.getByText(failure_message)).toBeTruthy();
  expect(screen.queryByText(/Gemini ingestion/i)).toBeNull();
  expect(screen.queryByText(failure_code)).toBeNull();
  expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  expect(created).not.toHaveBeenCalled();
});
