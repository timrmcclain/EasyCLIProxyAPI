import type { ComponentType, ReactNode } from 'react';
import { CircleAlert, LoaderCircle } from 'lucide-react';

type StateIcon = ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;

/**
 * The one way a list, panel or page says "loading", "nothing here" or "couldn't load".
 * page: fills a page's content area. section: a card or table body. panel: a dashed box inside a card.
 * inline: one line above content that is still coming.
 */
export function StateMessage({ kind, title, detail, icon: Icon, action, size = 'page', className }: {
  kind: 'loading' | 'empty' | 'error';
  title: ReactNode;
  detail?: ReactNode;
  /** Shown for empty states; loading and error have their own. */
  icon?: StateIcon;
  action?: ReactNode;
  size?: 'page' | 'section' | 'panel' | 'inline';
  className?: string;
}) {
  const iconSize = size === 'inline' ? 14 : size === 'page' ? 24 : 22;
  const symbol = kind === 'loading' ? <LoaderCircle size={iconSize} className="spin" aria-hidden="true" />
    : kind === 'error' ? <CircleAlert size={iconSize} aria-hidden="true" />
      : Icon ? <Icon size={iconSize} aria-hidden="true" /> : null;
  const role = kind === 'loading' ? 'status' : kind === 'error' ? 'alert' : undefined;
  return (
    <div className={['state-message', `state-message-${kind}`, `state-message-${size}`, className].filter(Boolean).join(' ')}
      role={role} aria-live={kind === 'loading' ? 'polite' : undefined}>
      {symbol}
      {detail ? <strong>{title}</strong> : <span>{title}</span>}
      {detail ? <span className="state-message-detail">{detail}</span> : null}
      {action}
    </div>
  );
}
