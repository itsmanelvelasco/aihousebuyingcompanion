import type { ReactNode } from 'react';
import { type IconName, iconAttributes, iconPaths, markSvg } from '../../../packages/ui/icons.ts';
import type { ToolError } from '../client.ts';
import { formatAgo, formatDate, safeHref, sourceHost } from '../format.ts';
import { useNow } from '../hooks.ts';

/** An icon from the shared set. Decorative unless `label` names what it stands for. */
export function Icon({ name, label }: { name: IconName; label?: string }) {
  return (
    <svg
      className="rc-icon"
      {...iconAttributes}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true, focusable: false })}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: static path data from packages/ui/icons.ts.
      dangerouslySetInnerHTML={{ __html: iconPaths[name] }}
    />
  );
}

/** The product wordmark: the mark, then ReloCat with "Cat" in the second colour. */
export function Wordmark() {
  return (
    <p className="rc-wordmark">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the static product mark from packages/ui/icons.ts. */}
      <span className="rc-mark" dangerouslySetInnerHTML={{ __html: markSvg }} />
      <span>
        Relo<b>Cat</b>
      </span>
    </p>
  );
}

/** Where a figure comes from: geography, date and a link, always next to the figure it describes. */
export function Source(props: { url: string; observedAt?: string | null; geography?: string | null; label?: string }) {
  const href = safeHref(props.url);
  const label = props.label ?? sourceHost(props.url);
  return (
    <small className="source">
      {props.geography === 'comarca' ? 'Comarca figure · ' : ''}
      {props.observedAt ? `${formatDate(props.observedAt)} · ` : ''}
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
      ) : (
        label
      )}
    </small>
  );
}

export function Switch(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
  describedBy?: string;
}) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        role="switch"
        aria-checked={props.checked}
        checked={props.checked}
        disabled={props.disabled}
        aria-describedby={props.describedBy}
        onChange={event => props.onChange(event.currentTarget.checked)}
      />
      <span className="switch-track" aria-hidden="true" />
      <span className="switch-label">{props.children}</span>
    </label>
  );
}

/** "12 s ago", kept current without re-rendering the rest of the panel. */
export function Ago({ since, every = 1000 }: { since: number; every?: number }) {
  const now = useNow(every);
  return <time dateTime={new Date(since).toISOString()}>{formatAgo(since, now)}</time>;
}

const errorTitles = {
  unavailable: 'Not available on this server',
  failed: 'The request failed',
  invalid: 'Unreadable answer',
};

/** A failed tool call, with the reason and a way to try again. Never replaced by sample data. */
export function ErrorNote(props: { title?: string; error: ToolError; onRetry?: () => void; compact?: boolean }) {
  return (
    <div className={props.compact ? 'rc-note rc-note--error note-compact' : 'rc-note rc-note--error'} role="alert">
      <p>
        <strong>{props.title ?? errorTitles[props.error.kind]}.</strong> {props.error.message}
      </p>
      {props.onRetry ? (
        <button type="button" className="rc-btn rc-btn--sm" onClick={props.onRetry}>
          <Icon name="refresh" />
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="rc-skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows.
        <span key={index} style={{ width: `${92 - ((index * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

export function Badge(props: {
  tone: 'ok' | 'warn' | 'muted' | 'violet' | 'off';
  icon?: IconName;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={props.tone === 'muted' ? 'rc-pill' : `rc-pill rc-pill--${props.tone}`} title={props.title}>
      {props.icon ? <Icon name={props.icon} /> : null}
      {props.children}
    </span>
  );
}
