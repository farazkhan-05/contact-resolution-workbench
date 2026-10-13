import { StrictMode, useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';

afterEach(cleanup);

function Harness({ dismissible = true }: { dismissible?: boolean }) {
  const [open, setOpen] = useState(false);
  const initial = useRef<HTMLTextAreaElement>(null);
  return <><button onClick={() => setOpen(true)}>Open test dialog</button>
    <Dialog open={open} onDismiss={() => setOpen(false)} dismissible={dismissible}
      labelledBy="title" describedBy="description" initialFocusRef={initial}>
      <h2 id="title">Synthetic dialog</h2><p id="description">Synthetic explanation</p>
      <textarea ref={initial} aria-label="Synthetic input" /><button onClick={() => setOpen(false)}>Close</button>
    </Dialog></>;
}

it('opens with a name, description, initial focus and scroll lock, then restores focus and styles', () => {
  document.body.style.overflow = 'auto'; document.documentElement.style.overflow = 'scroll';
  render(<Harness />); const trigger = screen.getByRole('button', { name: 'Open test dialog' });
  trigger.focus(); fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Synthetic dialog' });
  expect(dialog.getAttribute('aria-describedby')).toBe('description');
  expect(document.activeElement).toBe(screen.getByLabelText('Synthetic input'));
  expect(document.body.style.overflow).toBe('hidden');
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(trigger);
  expect(document.body.style.overflow).toBe('auto'); expect(document.documentElement.style.overflow).toBe('scroll');
  document.body.style.overflow = ''; document.documentElement.style.overflow = '';
});

it('prevents native Escape dismissal when dismissal is restricted', () => {
  render(<Harness dismissible={false} />); fireEvent.click(screen.getByText('Open test dialog'));
  const event = new Event('cancel', { cancelable: true }); fireEvent(screen.getByRole('dialog'), event);
  expect(event.defaultPrevented).toBe(true); expect(screen.getByRole('dialog')).toBeTruthy();
});

it('repairs focus when dynamic content removes the focused control', async () => {
  const close = vi.fn();
  const content = (input: boolean) => <Dialog open onDismiss={close} labelledBy="title" describedBy="description">
    <h2 id="title">Changing dialog</h2><p id="description">Synthetic input becomes accepted work</p>
    {input && <textarea aria-label="Draft" data-dialog-initial-focus />}<button>Close accepted work</button>
  </Dialog>;
  const view = render(content(true)); expect(document.activeElement).toBe(screen.getByLabelText('Draft'));
  view.rerender(content(false));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close accepted work' })));
});

it('repairs focus when the currently focused control becomes disabled', async () => {
  const view = render(<Dialog open onDismiss={vi.fn()} labelledBy="title" describedBy="description">
    <h2 id="title">Submitting</h2><p id="description">Synthetic request</p><button data-dialog-initial-focus>Submit</button><button>Available action</button>
  </Dialog>);
  view.rerender(<Dialog open onDismiss={vi.fn()} labelledBy="title" describedBy="description">
    <h2 id="title">Submitting</h2><p id="description">Synthetic request</p><button disabled data-dialog-initial-focus>Submit</button><button>Available action</button>
  </Dialog>);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByText('Available action')));
});

it('uses fallback focus if its initiating control disappears and cleans up on unmount', () => {
  const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
  const view = render(<Dialog open onDismiss={vi.fn()} labelledBy="title" describedBy="description">
    <h2 id="title">Unmount</h2><p id="description">Synthetic</p><button>Close</button>
  </Dialog>);
  trigger.remove(); view.unmount(); expect(document.activeElement).toBe(document.body);
  expect(document.body.hasAttribute('tabindex')).toBe(false);
  expect(document.body.style.overflow).toBe(''); expect(document.documentElement.style.overflow).toBe('');
  expect(document.querySelector('dialog')).toBeNull();
});

it('reopens and cleans up safely under StrictMode', () => {
  const view = render(<StrictMode><Harness /></StrictMode>);
  const trigger = screen.getByText('Open test dialog'); trigger.focus(); fireEvent.click(trigger);
  fireEvent.click(screen.getByText('Close')); fireEvent.click(trigger);
  expect(document.activeElement).toBe(screen.getByLabelText('Synthetic input'));
  view.unmount(); expect(document.body.style.overflow).toBe('');
});
