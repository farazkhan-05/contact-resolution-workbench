import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { Field, TextInput, Textarea } from './Field';
import { InlineFeedback, StatusIndicator } from './Feedback';

afterEach(cleanup);

it('blocks loading/disabled actions without removing their accessible names', () => {
  const action = vi.fn();
  render(<><Button loading onClick={action}>Extract evidence</Button><Button disabled onClick={action}>Disabled</Button>
    <Button iconOnly aria-label="Close synthetic dialog">×</Button></>);
  const busy = screen.getByRole('button', { name: 'Extract evidence' });
  expect(busy.getAttribute('aria-busy')).toBe('true'); fireEvent.click(busy); fireEvent.click(screen.getByText('Disabled'));
  expect(action).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'Close synthetic dialog' })).toBeTruthy();
});

it('connects field labels and validation text without duplicate urgent announcements', () => {
  render(<><Field id="note" label="Source note" error="Enter a source note.">{props => <Textarea {...props} />}</Field>
    <Field id="name" label="Source name" hint="Use a recognizable name.">{props => <TextInput {...props} />}</Field></>);
  const field = screen.getByLabelText('Source note'); expect(field.getAttribute('aria-invalid')).toBe('true');
  expect(document.getElementById(field.getAttribute('aria-describedby')!)?.textContent).toBe('Enter a source note.');
  expect(screen.getByLabelText('Source name').getAttribute('aria-invalid')).toBeNull(); expect(screen.queryByRole('alert')).toBeNull();
});

it.each(['info', 'success', 'warning'] as const)('announces ordinary %s feedback politely with one live region', tone => {
  render(<InlineFeedback tone={tone}><StatusIndicator tone={tone}>Synthetic progress</StatusIndicator></InlineFeedback>);
  expect(screen.getAllByRole('status')).toHaveLength(1); expect(screen.queryByRole('alert')).toBeNull();
});

it('uses urgent alert semantics for an actual error', () => {
  render(<InlineFeedback tone="error">Could not read history.</InlineFeedback>);
  expect(screen.getByRole('alert').textContent).toBe('Could not read history.'); expect(screen.queryByRole('status')).toBeNull();
});
