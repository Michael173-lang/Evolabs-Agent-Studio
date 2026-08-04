import { Check, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`studio-brand ${compact ? 'compact' : ''}`} aria-label="Evolabs">
      <span className="studio-brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" role="img">
          <path d="M8 7.5h16v4H12v3h10v4H12v3h12v4H8z" />
        </svg>
      </span>
      {!compact && (
        <span className="studio-brand-copy">
          <strong>Evolabs</strong>
          <small>Agent Studio 0.7.0</small>
        </span>
      )}
    </div>
  );
}

export function ProgressBar({ value }: { value: number }) {
  const width = Math.max(0, Math.min(100, value));
  return <span className="studio-progress" aria-label={`${Math.round(width)}%`}><i style={{ width: `${width}%` }} /></span>;
}

export function StatusPill({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'good' | 'warning' | 'bad' | 'working';
  children: ReactNode;
}) {
  return <span className={`studio-pill tone-${tone}`}>{tone === 'working' && <LoaderCircle size={12} className="spin" />}{children}</span>;
}

export function CheckLine({ done, children }: { done: boolean; children: ReactNode }) {
  return (
    <div className={`studio-check-line ${done ? 'done' : ''}`}>
      <span>{done ? <Check size={13} /> : null}</span>
      <p>{children}</p>
    </div>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  detail,
  action,
}: {
  eyebrow?: string;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <header className="studio-section-heading">
      <div>
        {eyebrow && <span>{eyebrow}</span>}
        <h2>{title}</h2>
        {detail && <p>{detail}</p>}
      </div>
      {action}
    </header>
  );
}
