import type { ComponentProps, ReactNode } from 'react';
import './ui.css';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export function StatusIndicator({ children, tone = 'neutral', ...props }: {
  children: ReactNode; tone?: Tone;
} & Omit<ComponentProps<'span'>, 'children'>) {
  // Live announcements are opt-in so a status inside feedback is not announced twice.
  return <span {...props} className={`ui-status ui-tone-${tone} ${props.className || ''}`}>{children}</span>;
}

export function InlineFeedback({ children, tone = 'info', className = '' }: {
  children: ReactNode; tone?: Tone; className?: string;
}) {
  return <div className={`ui-feedback ui-tone-${tone} ${className}`} role={tone === 'error' ? 'alert' : 'status'} aria-atomic="true">{children}</div>;
}
