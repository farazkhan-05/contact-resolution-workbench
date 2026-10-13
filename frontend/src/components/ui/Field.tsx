import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import './ui.css';

export function TextInput({ className = '', ...props }: ComponentPropsWithRef<'input'>) {
  return <input {...props} className={`ui-field-control ${className}`} />;
}

export function Textarea({ className = '', ...props }: ComponentPropsWithRef<'textarea'>) {
  return <textarea {...props} className={`ui-field-control ${className}`} />;
}

// The render function connects the control to its hint/error without cloning it.
export function Field({ id, label, hint, error, action, children }: {
  id: string; label: string; hint?: string; error?: string; action?: ReactNode;
  children: (accessibility: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true }) => ReactNode;
}) {
  const descriptionId = useId();
  return <div className="ui-field">
    <div className="ui-field-label"><label htmlFor={id}>{label}</label>{action}</div>
    {children({ id, 'aria-describedby': hint || error ? descriptionId : undefined, 'aria-invalid': error ? true : undefined })}
    {(hint || error) && <p id={descriptionId} className={error ? 'ui-field-error' : 'ui-field-hint'}>{error || hint}</p>}
  </div>;
}
