import type { ReactNode } from 'react';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand${compact ? ' brand--compact' : ''}`} aria-label="Evolabs Agent Studio">
      <span className="brand__mark" aria-hidden="true"><span>E</span></span>
      {!compact && (
        <span className="brand__copy">
          <strong>Evolabs</strong>
          <small>Agent Studio 0.8.0-beta.1</small>
        </span>
      )}
    </div>
  );
}

export function StatusPill({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'good' | 'warning' | 'danger' | 'working';
  children: ReactNode;
}) {
  return <span className={`status-pill status-pill--${tone}`}>{children}</span>;
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const normalized = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div className="progress" aria-label={label ?? `進度 ${Math.round(normalized)}%`}>
      <span className="progress__fill" style={{ width: `${normalized}%` }} />
    </div>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="section-header">
      <div className="section-header__copy">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="section-header__actions">{actions}</div>}
    </header>
  );
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}
