import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/** A button disclosure with natural Tab order, arrow navigation and focus return. */
export function ActionMenu({ label, trigger, children }: { label: string; trigger: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return <div className="action-menu" ref={root}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); }
      if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const items = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('.menu-content button:not(:disabled)') ?? []);
        if (!items.length) return;
        event.preventDefault();
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const target = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
          (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[target].focus();
      }
    }}>
    <button ref={triggerRef} type="button" className="shell-button menu-trigger" aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(!open)}>{trigger}</button>
    {open && <div id={id} className="menu-content" aria-label={label} onClick={(event) => {
      const button = (event.target as HTMLElement).closest('button');
      if (button && !button.classList.contains('help-trigger')) setOpen(false);
    }}>{children}</div>}
  </div>;
}
