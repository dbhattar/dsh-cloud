import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Card } from '../Card.tsx';
import { Button } from '../controls.tsx';
import styles from './Launching.module.css';

interface Status { state: 'running' | 'stopped' | 'error' | string; error?: string; resumed?: boolean; stage: number; elapsedMs: number }

interface View {
  title: string;
  sub: string;
  stage: number;
  allDone: boolean;
  meta: string;
  net: string;
  error: { message: string; detail: string } | null;
}

const INITIAL: View = { title: 'Starting your workspace', sub: 'Checking on your sandbox…', stage: 0, allDone: false, meta: '', net: '', error: null };

function friendly(e: string): string {
  if (/at capacity/.test(e)) return 'The service is full right now. Please try again in a few minutes.';
  if (/maximum run time|storage/i.test(e)) return e;
  if (/ENOTFOUND|EAI_AGAIN/.test(e)) return 'The gateway could not reach your sandbox on the internal network.';
  if (/exited during startup/.test(e)) return 'Your sandbox stopped while starting.';
  if (/timed out/.test(e)) return 'Your sandbox took too long to start.';
  if (/docker/i.test(e)) return 'The gateway could not talk to the container runtime.';
  return 'Something went wrong while starting your sandbox.';
}

/** Polls /gw/api/status and reloads into the workspace once the sandbox runs; updates in place so nothing flickers. */
export function Launching({ stages }: { stages: string[] }) {
  const [view, setView] = useState<View>(INITIAL);
  const patch = useCallback((p: Partial<View>) => setView((v) => ({ ...v, ...p })), []);
  const startRef = useRef<() => void>(() => {});

  useEffect(() => {
    let stopped = false;
    let starting = false;
    let fails = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = (fn: () => void, ms: number) => { timer = setTimeout(fn, ms); };

    const start = () => {
      if (starting) return;
      starting = true;
      patch({ error: null });
      fetch('/gw/api/start', { method: 'POST', credentials: 'same-origin' })
        .then(() => { starting = false; void poll(); }, () => { starting = false; later(() => void poll(), 1500); });
    };
    startRef.current = start;

    const poll = async () => {
      if (stopped) return;
      try {
        const r = await fetch('/gw/api/status', { credentials: 'same-origin', cache: 'no-store' });
        if (r.status === 401) { top!.location.href = '/gw/login'; return; }
        const j = (await r.json()) as Status;
        if (stopped) return;
        fails = 0;
        patch({ net: '' });
        if (j.state === 'running') {
          stopped = true;
          patch({ title: 'Your workspace is ready', sub: 'Opening it now…', allDone: true, meta: '' });
          location.reload();
          return;
        }
        if (j.state === 'error') {
          const detail = j.error || 'unknown error';
          patch({ title: 'We could not start your workspace', sub: '', stage: -1, meta: '', error: { message: friendly(detail), detail } });
          return;
        }
        if (j.state === 'stopped') { patch({ sub: 'Waking up your sandbox…' }); start(); return; }
        const s = Math.round(j.elapsedMs / 1000);
        patch({
          title: j.resumed ? 'Resuming your workspace' : 'Setting up your workspace',
          sub: j.resumed
            ? 'Your files and settings are kept. We are waking your sandbox.'
            : 'First visit: creating a private sandbox with its own storage. This can take up to a minute.',
          stage: j.stage < 0 ? 0 : j.stage,
          meta: `${s}s elapsed${s > 30 ? ' · taking longer than usual, still working…' : ''}`,
        });
        later(() => void poll(), 700);
      } catch {
        fails++;
        if (fails >= 3) patch({ net: 'Connection lost. Retrying…' });
        later(() => void poll(), 1500);
      }
    };

    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [patch]);

  return (
    <Card title={view.title} wide>
      <p className={styles.sub} role="status" aria-live="polite">{view.sub}</p>
      <ol className={styles.steps}>
        {stages.map((label, i) => {
          const state = view.allDone || i < view.stage ? 'done' : i === view.stage ? 'active' : 'todo';
          return (
            <li key={label} className={clsx(styles.step, styles[state])}>
              <span className={styles.dot} data-state={state} aria-hidden="true" />
              {label}
            </li>
          );
        })}
      </ol>
      {view.meta && <p className={styles.muted}>{view.meta}</p>}
      {view.net && <p className={styles.muted}>{view.net}</p>}
      {view.error && (
        <div className={styles.error} role="alert">
          <h2>Startup failed</h2>
          <p>{view.error.message}</p>
          <details><summary>Technical details</summary><span>{view.error.detail}</span></details>
          <Button type="button" onClick={() => startRef.current()}>Try again</Button>
        </div>
      )}
    </Card>
  );
}
