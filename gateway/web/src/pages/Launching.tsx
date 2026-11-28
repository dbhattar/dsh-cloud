import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Card } from '../Card.tsx';
import { Button } from '../controls.tsx';
import styles from './Launching.module.css';

/** A designed state from the gateway (gateway/src/states.js): the text is already plain language. */
interface Problem { code: string; severity: 'info' | 'warning' | 'error'; title: string; message: string; action: { kind: 'retry' | 'restart' | 'none'; label: string } }
interface Notice { code: string; severity: 'info'; message: string }
interface Queue { position: number; total: number; waitedSeconds: number; maxSeconds: number }
interface Status { state: 'running' | 'stopped' | 'error' | string; queue?: Queue | null; error?: string; problem?: Problem | null; notice?: Notice | null; resumed?: boolean; stage: number; elapsedMs: number }

interface View {
  title: string;
  sub: string;
  stage: number;
  allDone: boolean;
  meta: string;
  net: string;
  error: { problem: Problem; detail: string } | null;
}

/** 75 -> "1 min 15 s", 40 -> "40 s". */
const span = (s: number) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`);

const INITIAL: View = { title: 'Starting your workspace', sub: 'Checking on your sandbox…', stage: 0, allDone: false, meta: '', net: '', error: null };

/** Used only if the gateway sent no designed state (an older gateway, or an unexpected response). */
const GENERIC: Problem = {
  code: 'start_failed', severity: 'error', title: 'Your workspace could not start',
  message: 'Something went wrong. Your files are safe. Try again; if it keeps happening, send us feedback and include the details below.',
  action: { kind: 'retry', label: 'Try again' },
};

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
          const problem = j.problem ?? GENERIC;
          patch({ title: 'Your workspace', sub: '', stage: -1, meta: '', error: { problem, detail: j.error || 'no details available' } });
          return;
        }
        if (j.state === 'stopped') { patch({ sub: j.notice?.message ?? 'Waking up your workspace…' }); start(); return; }
        if (j.queue) {
          // The waiting room: the service is full. Asking for the status is what keeps this person's place in line.
          const q = j.queue;
          patch({
            title: 'Waiting for a place',
            sub: `You are number ${q.position} of ${q.total} in line. Your workspace starts by itself as soon as a place is free. Keep this page open.`,
            stage: 1,
            meta: `Waiting ${span(q.waitedSeconds)} · we stop waiting after ${span(q.maxSeconds)}`,
          });
          later(() => void poll(), 1500);
          return;
        }
        const s = Math.round(j.elapsedMs / 1000);
        patch({
          title: j.resumed ? 'Resuming your workspace' : 'Setting up your workspace',
          sub: j.notice?.message
            ?? (j.resumed
              ? 'Your files and settings are kept. We are waking your workspace.'
              : 'First visit: creating a private workspace with its own storage. This can take up to a minute.'),
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
        <div className={clsx(styles.error, view.error.problem.severity === 'warning' && styles.warning)} role="alert" data-problem={view.error.problem.code}>
          <h2>{view.error.problem.title}</h2>
          <p>{view.error.problem.message}</p>
          <details><summary>Technical details</summary><span>{view.error.detail}</span></details>
          {view.error.problem.action.kind !== 'none' && (
            <Button type="button" onClick={() => startRef.current()}>{view.error.problem.action.label}</Button>
          )}
        </div>
      )}
    </Card>
  );
}
