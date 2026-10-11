import type { ComponentPropsWithRef } from 'react';
import './ui.css';

type ButtonProps = ComponentPropsWithRef<'button'> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  loading?: boolean;
} & ({ iconOnly: true; 'aria-label': string } | { iconOnly?: false });

export function Button({ variant = 'secondary', loading = false, iconOnly, disabled,
  className = '', children, type = 'button', ...props }: ButtonProps) {
  return <button {...props} type={type} disabled={disabled || loading} aria-busy={loading || undefined}
    className={`ui-button ui-button-${variant}${iconOnly ? ' ui-button-icon' : ''} ${className}`}>
    {loading && <span className="ui-spinner" aria-hidden="true" />}{children}
  </button>;
}
