import { useId, useState } from 'react';
import { Card } from '../Card.tsx';
import { Button, ErrorNote, Field, inputClass } from '../controls.tsx';
import styles from '../form.module.css';

/** Ask for a reset link. The answer is the same whether or not the address has an account. */
export function Forgot({ available, sent, error, email }: { available: boolean; sent: boolean; error?: string | undefined; email?: string | null | undefined }) {
  if (!available) {
    return (
      <Card title="Reset your password">
        <p className={styles.note}>Password reset by email is not set up on this service. Ask whoever invited you to reset it for you.</p>
        <p className={styles.hint}><a href="/gw/login">Back to sign in</a></p>
      </Card>
    );
  }
  if (sent) {
    return (
      <Card title="Check your email">
        <p className={styles.good} role="status">If an account exists for that address, we have sent a link to choose a new password. It works once and expires soon.</p>
        <p className={styles.hint}>Nothing arrived? Check the spam folder, and wait a few minutes before asking again.</p>
        <p className={styles.hint}><a href="/gw/login">Back to sign in</a></p>
      </Card>
    );
  }
  return (
    <Card title="Reset your password">
      {error && <ErrorNote>{error}</ErrorNote>}
      <form className={styles.form} method="post" action="/gw/forgot" aria-label="Reset your password">
        <p className={styles.note}>Enter the email address of your account and we will send a link to choose a new password.</p>
        <Field label="Email"><input className={inputClass} name="email" type="email" autoComplete="username" defaultValue={email ?? ''} autoFocus required /></Field>
        <Button>Send the link</Button>
      </form>
      <p className={styles.hint}><a href="/gw/login">Back to sign in</a></p>
    </Card>
  );
}

const TOKEN_MESSAGES: Record<string, string> = {
  used: 'This link has already been used. If you still need to reset your password, ask for a new link.',
  expired: 'This link has expired. Ask for a new one.',
  unknown: 'This link is not valid. Check that you opened the whole link from the email, or ask for a new one.',
};

function NewPassword({ label, name, hint }: { label: string; name: string; hint?: string }) {
  const id = useId();
  return (
    <div className={styles.passwordField}>
      <label htmlFor={id} className={styles.passwordLabel}>{label}</label>
      <input id={id} className={inputClass} name={name} type="password" autoComplete="new-password" minLength={10} required />
      {hint && <p className={styles.hint}>{hint}</p>}
    </div>
  );
}

/** Choose a new password. Only a valid link shows the form. */
export function Reset({ token, status, error }: { token: string; status: string; error?: string | undefined }) {
  if (status !== 'valid') {
    return (
      <Card title="This link does not work">
        {error ? <ErrorNote>{error}</ErrorNote> : <p className={styles.note}>{TOKEN_MESSAGES[status] ?? TOKEN_MESSAGES.unknown}</p>}
        <p className={styles.hint}><a href="/gw/forgot">Ask for a new link</a> · <a href="/gw/login">Sign in</a></p>
      </Card>
    );
  }
  return (
    <Card title="Choose a new password">
      {error && <ErrorNote>{error}</ErrorNote>}
      <form className={styles.form} method="post" action="/gw/reset" aria-label="Choose a new password">
        <input type="hidden" name="token" value={token} />
        <NewPassword label="New password" name="password" hint="At least 10 characters." />
        <NewPassword label="New password again" name="confirm" />
        <Button>Change password</Button>
      </form>
      <p className={styles.hint}>Changing it signs you out everywhere.</p>
    </Card>
  );
}

/** A short message, with at most one button that posts a few hidden fields. */
export function Notice({ title, message, action }: { title: string; message: string; action?: { label: string; href: string; fields: Record<string, string> } | null | undefined }) {
  return (
    <Card title={title}>
      <p className={styles.note}>{message}</p>
      {action && (
        <form className={styles.form} method="post" action={action.href}>
          {Object.entries(action.fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          <Button>{action.label}</Button>
        </form>
      )}
    </Card>
  );
}

/** Ask for a place when sign-up needs an invite. The answer is the same for every address. */
export function Waitlist({ done, confirmMail, error, email }: { done: boolean; confirmMail: boolean; error?: string | undefined; email?: string | null | undefined }) {
  if (done) {
    return (
      <Card title="You are on the list">
        <p className={styles.good} role="status">{confirmMail ? 'We have sent a message to confirm your address. Open the link in it to stay on the list.' : 'Thank you. We will be in touch when a place opens.'}</p>
        {confirmMail && <p className={styles.hint}>Nothing arrived? Check the spam folder. If you do not confirm, we will not contact you.</p>}
        <p className={styles.hint}><a href="/gw/login">Back to sign in</a></p>
      </Card>
    );
  }
  return (
    <Card title="Join the waitlist">
      {error && <ErrorNote>{error}</ErrorNote>}
      <form className={styles.form} method="post" action="/gw/waitlist" aria-label="Join the waitlist">
        <p className={styles.note}>Sign-up is by invitation for now. Leave your email address and we will invite you when a place opens. We use it only for that.</p>
        <Field label="Email"><input className={inputClass} name="email" type="email" autoComplete="email" defaultValue={email ?? ''} autoFocus required /></Field>
        <Button>Join the waitlist</Button>
      </form>
      <p className={styles.hint}>Already invited? <a href="/gw/login">Sign in or create your account</a></p>
    </Card>
  );
}
