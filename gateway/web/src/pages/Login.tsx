import { useId, useState } from 'react';
import { Card } from '../Card.tsx';
import { Button, ErrorNote, Field, inputClass } from '../controls.tsx';
import styles from '../form.module.css';

/** Password input with a Show or Hide toggle. The label is tied by id (a button inside a <label> would be invalid). */
function PasswordField({ autoComplete, hint, minLength }: { autoComplete: string; hint?: string; minLength?: number }) {
  const id = useId();
  const [shown, setShown] = useState(false);
  return (
    <div className={styles.passwordField}>
      <label htmlFor={id} className={styles.passwordLabel}>Password</label>
      <div className={styles.passwordWrap}>
        <input id={id} className={inputClass} name="password" type={shown ? 'text' : 'password'} autoComplete={autoComplete} minLength={minLength} required />
        <button type="button" className={styles.reveal} aria-pressed={shown} aria-controls={id} onClick={() => setShown((v) => !v)}>
          {shown ? 'Hide' : 'Show'}<span className={styles.srOnly}> password</span>
        </button>
      </div>
      {hint && <p className={styles.hint}>{hint}</p>}
    </div>
  );
}

interface Props {
  error?: string | undefined;
  notice?: string | undefined;
  canReset?: boolean | undefined;
  canJoinWaitlist?: boolean | undefined;
  allowSignup: boolean;
  inviteRequired?: boolean | undefined;
  invite?: { code: string; status: 'valid' | 'used' | 'expired' | 'revoked' | 'unknown' } | null | undefined;
  next?: string | null | undefined;
  email?: string | null | undefined;
  mode?: 'login' | 'signup' | undefined;
}

export function Login({ error, notice, canReset = false, canJoinWaitlist = false, allowSignup, inviteRequired = false, invite = null, next = null, email = null, mode = 'login' }: Props) {
  const signInForm = (
    <form key="signin" className={styles.form} method="post" action="/gw/login" aria-label="Sign in">
      {mode === 'signup' && <h2 className={styles.heading}>Already have an account?</h2>}
      {next && <input type="hidden" name="next" value={next} />}
      <Field label="Email"><input className={inputClass} name="email" type="email" autoComplete="username" defaultValue={mode === 'login' ? email ?? '' : ''} autoFocus={mode === 'login'} required /></Field>
      <PasswordField autoComplete="current-password" />
      <Button variant={mode === 'signup' ? 'outline' : 'primary'}>Sign in</Button>
      {canReset && <p className={styles.hint}><a href="/gw/forgot">Forgot your password?</a></p>}
    </form>
  );
  const signUpForm = allowSignup && (
    <form key="signup" className={`${styles.form} ${mode === 'login' ? styles.divider : ''}`} method="post" action="/gw/signup" aria-label="Create account">
      {mode === 'login' && <h2 className={styles.heading}>Create your account</h2>}
      {mode === 'signup' && invite?.status === 'valid' && <p className={styles.good} role="status">You have been invited. Create your account to get started.</p>}
      {next && <input type="hidden" name="next" value={next} />}
      <Field label="Email"><input className={inputClass} name="email" type="email" autoComplete="username" defaultValue={mode === 'signup' ? email ?? '' : ''} autoFocus={mode === 'signup'} required /></Field>
      <PasswordField autoComplete="new-password" minLength={10} hint="At least 10 characters." />
      {inviteRequired && (
        <Field label="Invite code"><input className={inputClass} name="invite" type="text" autoComplete="off" spellCheck={false} defaultValue={invite?.code ?? ''} required /></Field>
      )}
      <Button variant={mode === 'signup' ? 'primary' : 'outline'}>Create account</Button>
      {inviteRequired && canJoinWaitlist && <p className={styles.hint}>No invite? <a href="/gw/waitlist">Join the waitlist</a></p>}
    </form>
  );
  return (
    <Card title={mode === 'signup' ? 'Create your account' : 'Sign in'}>
      {notice && <p className={styles.good} role="status">{notice}</p>}
      {error && <ErrorNote>{error}</ErrorNote>}
      {mode === 'signup' ? <>{signUpForm}<div className={styles.divider}>{signInForm}</div></> : <>{signInForm}{signUpForm}</>}
    </Card>
  );
}
