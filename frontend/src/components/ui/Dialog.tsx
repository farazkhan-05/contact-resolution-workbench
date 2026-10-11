import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import './ui.css';

export function Dialog({ open, onDismiss, dismissible = true, labelledBy, describedBy,
  initialFocusRef, returnFocusRef, children, className = '' }: {
  open: boolean; onDismiss: () => void; dismissible?: boolean;
  labelledBy: string; describedBy: string; children: ReactNode; className?: string;
  initialFocusRef?: RefObject<HTMLElement | null>; returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const element = useRef<HTMLDialogElement>(null);
  const focusOptions = useRef({ initialFocusRef, returnFocusRef });
  useLayoutEffect(() => { focusOptions.current = { initialFocusRef, returnFocusRef }; });
  useLayoutEffect(() => {
    if (!open) return;
    const dialog = element.current!;
    const active = document.activeElement;
    const trigger = active instanceof HTMLElement && active !== document.body && active !== document.documentElement ? active : null;
    const overflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    dialog.showModal();
    const focusInside = () => {
      const preferred = focusOptions.current.initialFocusRef?.current;
      const target = preferred && !preferred.matches(':disabled, [hidden]') ? preferred :
        dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]:not(:disabled), [autofocus]:not(:disabled)') ||
        dialog.querySelector<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), [tabindex="0"]') || dialog;
      target.focus();
    };
    focusInside();
    // Native modal focus containment uses the current DOM. Repair focus when a
    // submitting control is disabled or replaced by accepted Job content.
    const observer = new MutationObserver(() => {
      if (!dialog.contains(document.activeElement) || document.activeElement?.matches(':disabled')) focusInside();
    });
    observer.observe(dialog, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden'] });
    return () => {
      observer.disconnect();
      if (dialog.open) dialog.close();
      document.body.style.overflow = overflow;
      document.documentElement.style.overflow = rootOverflow;
      const target = focusOptions.current.returnFocusRef?.current || trigger;
      if (target?.isConnected && !target.matches(':disabled, [hidden]')) target.focus();
      else {
        const fallback = document.querySelector<HTMLElement>('[aria-label="More case actions"]') ||
          document.querySelector<HTMLElement>('#root button:not(:disabled)');
        if (fallback) fallback.focus();
        else {
          const tabIndex = document.body.getAttribute('tabindex');
          document.body.tabIndex = -1;
          document.body.focus();
          if (tabIndex === null) document.body.removeAttribute('tabindex');
          else document.body.setAttribute('tabindex', tabIndex);
        }
      }
    };
  }, [open]);

  if (!open) return null;
  return createPortal(<dialog ref={element} className={`ui-dialog ${className}`} tabIndex={-1}
    aria-modal="true" aria-labelledby={labelledBy} aria-describedby={describedBy}
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )).filter(control => control.getClientRects().length && !control.closest('[hidden], [inert]') && getComputedStyle(control).visibility !== 'hidden');
      const first = controls[0]; const last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); event.currentTarget.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {
        event.preventDefault(); first.focus();
      }
    }}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (dismissible) onDismiss(); }}>
    {children}
  </dialog>, document.body);
}
