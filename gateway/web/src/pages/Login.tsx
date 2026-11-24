import { Card } from '../Card.tsx';
import { Button, ErrorNote, Field, inputClass } from '../controls.tsx';
import styles from '../form.module.css';

function Fields({ passwordAutocomplete }: { passwordAutocomplete: string }) {
  return (
    <>
      <Field label="Email"><input className={inputClass} name="email" type="email" autoComplete="username" required /></Field>
      <Field label="Password"><input className={inputClass} name="password" type="password" autoComplete={passwordAutocomplete} minLength={10} required /></Field>
    </>
  );
}

export function Login({ error, allowSignup, inviteRequired = false }: { error?: string | undefined; allowSignup: boolean; inviteRequired?: boolean }) {
  return (
    <Card title="Sign in">
      {error && <ErrorNote>{error}</ErrorNote>}
      <form className={styles.form} method="post" action="/gw/login">
        <Fields passwordAutocomplete="current-password" />
        <Button>Sign in</Button>
      </form>
      {allowSignup && (
        <form className={`${styles.form} ${styles.divider}`} method="post" action="/gw/signup">
          <h2 style={{ margin: 0, fontSize: 16, lineHeight: '24px' }}>Create account</h2>
          <Fields passwordAutocomplete="new-password" />
          {inviteRequired && (
            <Field label="Invite code"><input className={inputClass} name="invite" type="text" autoComplete="off" required /></Field>
          )}
          <Button variant="outline">Sign up</Button>
        </form>
      )}
    </Card>
  );
}
