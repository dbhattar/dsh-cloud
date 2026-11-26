import { useEffect, useRef } from 'react';
import { Button } from '../controls.tsx';
import { limitsSentence, pauseSentence, type Policy, type Tokens } from './welcome-text.ts';
import styles from './Welcome.module.css';

/** One-screen welcome: what this is, how work is saved, the limits, privacy, getting work out. Shown once, reopenable. */
export function Welcome({ policy, tokens, onClose }: { policy: Policy | null; tokens: Tokens | null; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.querySelector('button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className={styles.overlay}>
      <div ref={dialog} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="welcome-title">
        <h2 id="welcome-title" className={styles.title}>Welcome to your workspace</h2>
        <p>This is a private workspace with an AI coding agent. Describe what you want to build and the agent writes code, runs commands and edits files for you, in a sandbox that belongs to you.</p>
        <h3 className={styles.heading}>How your work is saved</h3>
        <p>{pauseSentence(policy)}</p>
        <h3 className={styles.heading}>Limits</h3>
        <p>{limitsSentence(policy, tokens)} The usage button in the top bar shows where you stand and warns you before a limit.</p>
        <h3 className={styles.heading}>Privacy and safety</h3>
        <p>Only you can see your workspace. Commands run in a sandbox, and the agent asks before it steps outside your workspace. Treat the agent like any online service: do not paste secrets you could not afford to leak.</p>
        <h3 className={styles.heading}>Getting your work out</h3>
        <p>Your project files live in your workspace. One-click download and Git push are still being built; until then, tell us what you need with Send feedback.</p>
        <div className={styles.actions}><Button type="button" onClick={onClose}>Got it</Button></div>
      </div>
    </div>
  );
}
