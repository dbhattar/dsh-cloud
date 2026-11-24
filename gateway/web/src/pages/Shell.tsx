import { useCallback, useEffect, useRef, useState } from 'react';
import { BrandWordmark } from '../BrandWordmark.tsx';
import { Button } from '../controls.tsx';
import { FEEDBACK_CLOSE } from './Feedback.tsx';
import styles from './Shell.module.css';

const HOOKED = '__gwOpenHooked';

/** The harness opens its feedback form with window.open(..., '_blank'); we show it in-page instead. */
function isFeedbackUrl(url: string | URL | undefined): url is string | URL {
  if (!url) return false;
  try {
    const u = new URL(url, location.href);
    return u.origin === location.origin && u.pathname === '/gw/feedback';
  } catch {
    return false;
  }
}

interface UsageWindow { used: number; limit: number | null; resetsAt: string }
interface Usage { day: UsageWindow; month: UsageWindow; exhausted: boolean; blockedBy: 'day' | 'month' | null }

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** Token usage for the signed-in user, refreshed while the page is open. Null when metering is off or unreachable. */
function useUsage(): Usage | null {
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => fetch('/gw/api/usage').then((r) => (r.ok ? r.json() : null)).then((u: Usage | null) => { if (live) setUsage(u); }, () => {});
    load();
    const t = setInterval(load, 30_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return usage;
}

/** Authenticated top-level page: account bar + the harness UI in a same-origin iframe. */
export function Shell({ email, src }: { email: string; src: string }) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const close = useCallback(() => setFeedback(null), []);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const usage = useUsage();
  const blocked = usage?.blockedBy ? usage[usage.blockedBy] : null;

  // Same origin, so the shell can wrap the harness window's open(). Re-applied on every iframe load.
  const hook = useCallback((frame: HTMLIFrameElement) => {
    const win = frame.contentWindow;
    // A navigated iframe keeps the same WindowProxy but gets a fresh document, so mark the document's own open().
    if (!win || (win as unknown as Record<string, unknown>)[HOOKED]) return;
    (win as unknown as Record<string, unknown>)[HOOKED] = true;
    const original = win.open.bind(win);
    win.open = (url, ...rest) => {
      if (isFeedbackUrl(url)) {
        setFeedback(new URL(url, location.href).href);
        return null;
      }
      return original(url, ...rest);
    };
  }, []);

  useEffect(() => { if (frameRef.current) hook(frameRef.current); }, [hook]);

  useEffect(() => {
    if (feedback === null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onMessage = (e: MessageEvent) => { if (e.origin === location.origin && e.data === FEEDBACK_CLOSE) close(); };
    addEventListener('keydown', onKey);
    addEventListener('message', onMessage);
    return () => { removeEventListener('keydown', onKey); removeEventListener('message', onMessage); };
  }, [feedback, close]);

  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <BrandWordmark size={16} />
        {usage && (
          <span className={styles.usage} title={`Resets ${when(usage.day.resetsAt)}`}>
            Today {compact.format(usage.day.used)}{usage.day.limit !== null && ` / ${compact.format(usage.day.limit)}`} tokens
          </span>
        )}
        <span className={styles.email}>{email}</span>
        <form method="post" action="/gw/logout"><Button variant="outline" className={styles.signout}>Sign out</Button></form>
      </header>
      {usage?.exhausted && blocked && (
        <div className={styles.banner} role="alert">
          You have used your {usage.blockedBy === 'day' ? 'daily' : 'monthly'} token allowance. Model requests resume {when(blocked.resetsAt)}.
        </div>
      )}
      <iframe
        className={styles.frame}
        src={src}
        title="DeepSeek Harness"
        allow="clipboard-read; clipboard-write; fullscreen"
        ref={frameRef}
        onLoad={(e) => hook(e.currentTarget)}
      />
      {feedback !== null && (
        <div className={styles.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Send feedback">
            <button type="button" className={styles.x} onClick={close} aria-label="Close">×</button>
            <iframe className={styles.dialogFrame} src={feedback} title="Send feedback" />
          </div>
        </div>
      )}
    </div>
  );
}
