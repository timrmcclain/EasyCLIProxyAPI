import { useCallback, useEffect, useId, useReducer, useRef, useState } from 'react';
import { NoticePortal } from './components/NoticePortal';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useI18n } from './i18n';
import type { MessageKey } from './i18n/resources';
import {
  appNoticeReducer,
  initialAppNoticeState,
  type AppNotice,
  type AppNoticeAction,
  type AppNoticeState,
  type NoticeTone,
  type NoticeMessage,
} from './services/appNotice';

export type { NoticeTone, NoticeMessage, AppNotice, AppNoticeState, AppNoticeAction };

/** A single follow-up control shown inside a notice, e.g. Undo after an instant change. */
export type NoticeActionButton = { label: NoticeMessage; onAction: () => void };
export type NoticeOptions = { action?: NoticeActionButton };
type NoticeWithAction = AppNotice & { action?: NoticeActionButton };

export interface UseAppNoticeReturn {
  showNotice: (message: NoticeMessage, tone?: NoticeTone, options?: NoticeOptions) => void;
  clearNotice: () => void;
  notice: AppNotice | null;
  revision: number;
}

/**
 * Feedback model used across the app:
 * - transient results (saved, copied, applied, deleted) float and auto-dismiss on success
 *   (paused while hovered or focused);
 * - errors stay until dismissed and render inline where the notice is placed
 *   (FeedbackNotice, or MessageNotice with `inline`).
 */
export function useAppNotice(source?: MessageKey): UseAppNoticeReturn {
  const [state, dispatch] = useReducer(appNoticeReducer, initialAppNoticeState);
  const owner = useId();

  const showNotice = useCallback((message: NoticeMessage, tone: NoticeTone = 'success', options?: NoticeOptions) => {
    const notice: NoticeWithAction = { owner, source, message, tone, ...(options?.action ? { action: options.action } : {}) };
    dispatch({ type: 'show', notice });
  }, [owner, source]);

  const clearNotice = useCallback(() => {
    dispatch({ type: 'dismiss', owner });
  }, [owner]);

  return {
    showNotice,
    clearNotice,
    notice: state.notice,
    revision: state.revision,
  };
}

export interface InlineNoticeProps {
  notice?: AppNotice | null;
  onDismiss?: () => void;
  className?: string;
}

export function InlineNotice({
  notice,
  onDismiss,
  className = '',
}: InlineNoticeProps) {
  const { t } = useI18n();

  const message = notice
    ? typeof notice.message === 'string' ? notice.message : t(notice.message.key, notice.message.variables)
    : '';

  if (!notice || !message.trim()) {
    return null;
  }

  const Icon = notice.tone === 'error' ? AlertCircle : notice.tone === 'success' ? CheckCircle2 : Info;
  const isError = notice.tone === 'error';
  const action = (notice as NoticeWithAction).action;
  const actionLabel = action ? typeof action.label === 'string' ? action.label : t(action.label.key, action.label.variables) : '';

  return (
    <div
      className={('action-feedback inline-notice ' + notice.tone + (className ? ' ' + className : '')).trim()}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <div className="action-feedback-main">
        <Icon size={16} className="action-feedback-icon" aria-hidden="true" />
        <div className="action-feedback-text" tabIndex={0}>
          {notice.source ? <strong className="action-feedback-source">{t(notice.source)}: </strong> : null}
          <span className="action-feedback-message">{message}</span>
        </div>
      </div>
      {action && actionLabel ? (
        <button
          type="button"
          className="action-feedback-action"
          onClick={() => {
            action.onAction();
            onDismiss?.();
          }}
        >
          {actionLabel}
        </button>
      ) : null}
      {onDismiss ? (
        <button
          type="button"
          className="action-feedback-dismiss"
          onClick={onDismiss}
          aria-label={t('app.notice.dismiss')}
          title={t('app.notice.dismiss')}
        >
          <X size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function FloatingNotice(props: InlineNoticeProps) {
  const { t } = useI18n();
  const { notice } = props;
  if (!notice) return null;
  const message = typeof notice.message === 'string' ? notice.message : t(notice.message.key, notice.message.variables);
  if (!message.trim()) return null;
  return <FloatingNoticeInstance key={notice.tone + ':' + message} {...props} notice={notice} />;
}

function FloatingNoticeInstance({ notice, onDismiss, className }: InlineNoticeProps & { notice: AppNotice }) {
  const [dismissed, setDismissed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const entryRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const dismissRef = useRef(onDismiss);
  useEffect(() => { dismissRef.current = onDismiss; }, [onDismiss]);
  const dismiss = useCallback(() => {
    const entry = entryRef.current;
    if (entry?.contains(document.activeElement)) {
      const dialog = entry.closest('dialog, [role="dialog"], [role="alertdialog"]');
      const previous = returnFocusRef.current;
      const target = previous?.isConnected && !previous.matches(':disabled')
        && !previous.closest('.app-notice-stack') && (!dialog || dialog.contains(previous))
        ? previous
        : Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])
          .find(control => !control.closest('.app-notice-stack') && control.getClientRects().length > 0);
      target?.focus();
    }
    setDismissed(true);
    dismissRef.current?.();
  }, []);
  useEffect(() => {
    if (dismissed || hovered || focused || notice.tone !== 'success') return;
    const timer = window.setTimeout(dismiss, 6_000);
    return () => window.clearTimeout(timer);
  }, [dismissed, hovered, focused, notice.tone, dismiss]);
  if (dismissed) return null;
  return <NoticePortal>
    <div ref={entryRef} className="app-notice-entry"
      onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
      onFocusCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          returnFocusRef.current = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
        }
        setFocused(true);
      }}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
      onKeyDown={(event) => { if (event.key !== 'Tab') event.stopPropagation(); }}
      onClick={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
      <InlineNotice notice={notice} onDismiss={dismiss} className={className} />
    </div>
  </NoticePortal>;
}

/**
 * A notice driven by a message prop. Pass `inline` for persistent problems that need action, so the
 * message renders next to the control that failed instead of floating over the page.
 */
export function MessageNotice({ message, tone = 'error', onDismiss, source, inline = false, className }: {
  message?: NoticeMessage | null;
  tone?: NoticeTone;
  onDismiss?: () => void;
  source?: MessageKey;
  inline?: boolean;
  className?: string;
}) {
  const owner = useId();
  const notice = message ? { owner, message, tone, source } : null;
  return inline
    ? <InlineNotice notice={notice} onDismiss={onDismiss} className={className} />
    : <FloatingNotice notice={notice} onDismiss={onDismiss} className={className} />;
}

/**
 * Renders the current result of a useAppNotice() hook with the app-wide rule: errors stay inline
 * where this element is placed; success and info float, and success auto-dismisses.
 */
export function FeedbackNotice({ feedback, className }: { feedback: UseAppNoticeReturn; className?: string }) {
  const { notice, revision, clearNotice } = feedback;
  if (notice?.tone === 'error') {
    return <InlineNotice key={revision} notice={notice} onDismiss={clearNotice} className={className} />;
  }
  return <FloatingNotice key={revision} notice={notice} onDismiss={clearNotice} className={className} />;
}

export const ActionFeedback = FloatingNotice;
