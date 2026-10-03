import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { Job } from '../../types';
import { AiExtractionModal } from './AiExtractionModal';

vi.mock('../../api/client', async (original) => {
  const actual = await original<typeof import('../../api/client')>();
  return { ...actual, api: { ...actual.api, ingestUnstructured: vi.fn(), getJob: vi.fn() } };
});

afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

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
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Extract & Resolve' })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.getByText('AI evidence extraction failed.')).toBeTruthy();
  expect(screen.getByText(failure_message)).toBeTruthy();
  expect(screen.queryByText(/Gemini ingestion/i)).toBeNull();
  expect(screen.queryByText(failure_code)).toBeNull();
  expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  expect(created).not.toHaveBeenCalled();
});
