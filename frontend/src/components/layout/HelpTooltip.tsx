import { useId, useState } from 'react';
import { HelpCircle } from 'lucide-react';

export function HelpTooltip({ label, text }: { label: string; text: string }) {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return <span className="help-tooltip" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
    <button type="button" className="help-trigger" aria-label={`${label} help`} aria-describedby={id}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onKeyDown={(event) => { if (event.key === 'Escape') { setFocused(false); setHovered(false); } }}>
      <HelpCircle size={14} aria-hidden="true" />
    </button>
    <span id={id} role="tooltip" className="help-text" hidden={!hovered && !focused}>{text}</span>
  </span>;
}
