import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BrandWordmark } from '../BrandWordmark.tsx';
import { Button } from '../controls.tsx';
import { curate } from '../curate.ts';
import { FEEDBACK_CLOSE } from './Feedback.tsx';
import type { Policy } from './welcome-text.ts';
import { Welcome } from './Welcome.tsx';
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

/** A designed state or early warning from the gateway (gateway/src/states.js): the text is already plain language. */
interface Notice { code: string; severity: 'info' | 'warning' | 'error'; title: string; message: string; meter?: string; percent?: number }
interface UsageWindow { used: number; limit: number | null; resetsAt: string }
interface Limits {
  workspace: { state: string };
  policy?: Policy;
  tokens: { day: UsageWindow; month: UsageWindow } | null;
  storage: { usedBytes: number; limitBytes: number | null } | null;
  run: { maxSeconds: number; secondsLeft: number } | null;
  problem: Notice | null;
  warnings: Notice[];
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const mb = (bytes: number) => `${new Intl.NumberFormat('en').format(Math.round(bytes / 1024 / 1024))} MB`;
function span(seconds: number): string {
  if (seconds >= 3600) { const h = Math.floor(seconds / 3600); const m = Math.round((seconds % 3600) / 60); return m ? `${h} h ${m} min` : `${h} h`; }
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

/** The numbers behind the usage panel, refreshed while the page is open and on demand. Null when unavailable. */
function useLimits(): { limits: Limits | null; reload: () => void } {
  const [limits, setLimits] = useState<Limits | null>(null);
  const live = useRef(true);
  const reload = useCallback(() => {
    fetch('/gw/api/limits').then((r) => (r.ok ? r.json() : null)).then((l: Limits | null) => { if (live.current) setLimits(l); }, () => {});
  }, []);
  useEffect(() => {
    live.current = true;
    reload();
    // The workspace is usually still starting at first load, so the run-time and storage numbers are missing at first: look again soon.
    const early = [4_000, 10_000, 20_000].map((ms) => setTimeout(reload, ms));
    const t = setInterval(reload, 30_000);
    return () => { live.current = false; clearInterval(t); early.forEach(clearTimeout); };
  }, [reload]);
  return { limits, reload };
}

/** What to show in the banner: a spent allowance first, otherwise the most urgent early warning. */
function bannerOf(l: Limits | null): Notice | null {
  return l?.problem ?? l?.warnings[0] ?? null;
}

function Meter({ label, value, percent, detail }: { label: string; value: string; percent: number | null; detail?: string }) {
  const level = percent === null ? 'ok' : percent >= 95 ? 'critical' : percent >= 80 ? 'high' : 'ok';
  return (
    <div className={styles.meter}>
      <div className={styles.meterHead}><span>{label}</span><span className={styles.meterValue}>{value}</span></div>
      {percent !== null && (
        <div className={styles.track} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(percent))}>
          <div className={clsx(styles.fill, styles[level])} style={{ width: `${Math.min(100, percent)}%` }} />
        </div>
      )}
      {detail && <div className={styles.meterDetail}>{detail}</div>}
    </div>
  );
}

/** A button that asks twice: the first click arms it for a few seconds, the second does it. */
function ConfirmButton({ label, confirmLabel, busy, onConfirm, className }: { label: string; confirmLabel: string; busy: boolean; onConfirm: () => void; className?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 5000); return () => clearTimeout(t); }, [armed]);
  return (
    <Button type="button" variant={armed ? 'primary' : 'outline'} className={className} disabled={busy}
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      {busy ? 'Working…' : armed ? confirmLabel : label}
    </Button>
  );
}

function UsagePanel({ limits, busy, onStop, onRestart, onWelcome }: { limits: Limits; busy: 'stop' | 'restart' | null; onStop: () => void; onRestart: () => void; onWelcome: () => void }) {
  const t = limits.tokens;
  const dayPct = t?.day.limit ? (t.day.used / t.day.limit) * 100 : null;
  const monthPct = t?.month.limit ? (t.month.used / t.month.limit) * 100 : null;
  const s = limits.storage;
  const storagePct = s?.limitBytes ? (s.usedBytes / s.limitBytes) * 100 : null;
  const r = limits.run;
  const runPct = r ? ((r.maxSeconds - r.secondsLeft) / r.maxSeconds) * 100 : null;
  return (
    <div className={styles.panel} role="dialog" aria-label="Usage and limits">
      {limits.warnings.length > 0 && (
        <ul className={styles.warnList}>
          {limits.warnings.map((w) => <li key={w.code} className={styles[`sev_${w.severity}`]}><strong>{w.title}.</strong> {w.message}</li>)}
        </ul>
      )}
      {t && (
        <>
          <Meter label="Model tokens today" value={`${compact.format(t.day.used)}${t.day.limit ? ` / ${compact.format(t.day.limit)}` : ''}`} percent={dayPct} detail={`Resets ${when(t.day.resetsAt)}`} />
          <Meter label="Model tokens this month" value={`${compact.format(t.month.used)}${t.month.limit ? ` / ${compact.format(t.month.limit)}` : ''}`} percent={monthPct} detail={`Resets ${when(t.month.resetsAt)}`} />
        </>
      )}
      {s && <Meter label="Storage" value={`${mb(s.usedBytes)}${s.limitBytes ? ` / ${mb(s.limitBytes)}` : ''}`} percent={storagePct} detail="Files, sessions and settings in your workspace" />}
      {r && <Meter label="This run" value={`${span(r.secondsLeft)} left`} percent={runPct} detail={`A workspace can run for ${span(r.maxSeconds)} at a time; stopping it only pauses it`} />}
      <div className={styles.actions}>
        <ConfirmButton label="Restart workspace" confirmLabel="Click again to restart" busy={busy === 'restart'} onConfirm={onRestart} />
        <ConfirmButton label="Stop workspace" confirmLabel="Click again to stop" busy={busy === 'stop'} onConfirm={onStop} />
      </div>
      <p className={styles.fine}>Restarting or stopping ends any command or task that is running. Your files and sessions are kept.</p>
      <button type="button" className={styles.linkButton} onClick={onWelcome}>About this workspace</button>
    </div>
  );
}

/** Authenticated top-level page: account bar + the harness UI in a same-origin iframe. */
export function Shell({ email, src, workspaceName = 'Workspace' }: { email: string; src: string; workspaceName?: string | undefined }) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const close = useCallback(() => setFeedback(null), []);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const { limits, reload } = useLimits();
  // The welcome screen: shown once per user (the server remembers), and reopenable from the usage panel.
  const [welcome, setWelcome] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false); // the server says; the admin routes check again on every request
  useEffect(() => {
    fetch('/gw/api/me').then((r) => (r.ok ? r.json() : null)).then((me: { welcomed?: boolean; admin?: boolean } | null) => { if (me && me.welcomed === false) setWelcome(true); if (me?.admin) setIsAdmin(true); }, () => {});
  }, []);
  const closeWelcome = useCallback(() => {
    setWelcome(false);
    fetch('/gw/api/welcome', { method: 'POST' }).catch(() => {}); // no-op if already recorded; a failure just shows it again next time
  }, []);
  const [panel, setPanel] = useState(false);
  const [busy, setBusy] = useState<'stop' | 'restart' | null>(null);
  const [frameKey, setFrameKey] = useState(0); // bumping it reloads the workspace frame
  const banner = bannerOf(limits);
  const post = async (url: string, which: 'stop' | 'restart') => {
    setBusy(which);
    try { await fetch(url, { method: 'POST' }); } catch { /* the reloaded frame shows the real state */ }
    setBusy(null);
    setPanel(false);
    setFrameKey((k) => k + 1);
    setTimeout(reload, 1500);
  };

  // Same origin, so the shell can wrap the harness window's open(). Re-applied on every iframe load.
  const hook = useCallback((frame: HTMLIFrameElement) => {
    const win = frame.contentWindow;
    if (!win) return;
    // Curate every document the frame shows. This must come before the guard below: a frame's first real page can reuse the
    // window the frame started with (same origin), which already carries the marker, and would otherwise never be curated.
    // curate() is idempotent per document.
    try { curate(win.document, { workspaceName, headline: 'What would you like to build?' }); } catch { /* the page is not ready or not ours: leave the harness as it is */ }
    // The marker is on the window, and so is the wrapped open(): both survive a reused window, and a fresh one gets neither.
    if ((win as unknown as Record<string, unknown>)[HOOKED]) return;
    (win as unknown as Record<string, unknown>)[HOOKED] = true;
    const original = win.open.bind(win);
    win.open = (url, ...rest) => {
      if (isFeedbackUrl(url)) {
        setFeedback(new URL(url, location.href).href);
        return null;
      }
      return original(url, ...rest);
    };
  }, [workspaceName]);

  useEffect(() => { if (frameRef.current) hook(frameRef.current); }, [hook]);

  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPanel(false); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [panel]);

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
        {isAdmin && <a className={styles.adminLink} href="/gw/admin">Admin</a>}
        {limits && (
          <button type="button" className={clsx(styles.usage, banner && styles[`chip_${banner.severity}`])} aria-expanded={panel} aria-haspopup="dialog" onClick={() => { if (!panel) reload(); setPanel((v) => !v); }}>
            {limits.tokens ? <>Today {compact.format(limits.tokens.day.used)}{limits.tokens.day.limit !== null && ` / ${compact.format(limits.tokens.day.limit)}`} tokens</> : 'Usage'}
            {banner && <span className={styles.dot} aria-hidden="true" />}
          </button>
        )}
        <span className={styles.email}>{email}</span>
        <form method="post" action="/gw/logout"><Button variant="outline" className={styles.signout}>Sign out</Button></form>
      </header>
      {panel && limits && <UsagePanel limits={limits} busy={busy} onStop={() => void post('/gw/api/stop?hold=1', 'stop')} onRestart={() => void post('/gw/api/restart', 'restart')} onWelcome={() => { setPanel(false); setWelcome(true); }} />}
      {welcome && <Welcome policy={limits?.policy ?? null} tokens={limits?.tokens ?? null} onClose={closeWelcome} />}
      {banner && !panel && (
        <div className={clsx(styles.banner, styles[`sev_${banner.severity}`])} role={limits?.problem ? 'alert' : 'status'} data-problem={banner.code}>
          <strong>{banner.title}.</strong> {banner.message}
        </div>
      )}
      <iframe
        key={frameKey}
        className={styles.frame}
        src={src}
        title="Workspace"
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
