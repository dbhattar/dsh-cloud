import { Card } from '../Card.tsx';
import { Button, ErrorNote, Field, inputClass } from '../controls.tsx';
import styles from '../form.module.css';

/** Posted to the parent shell when the form is shown in its dialog and the user is done. */
export const FEEDBACK_CLOSE = 'gw-feedback-close';

interface Props { email: string; context: Record<string, string>; kinds: string[]; sent?: boolean | undefined; error?: string | undefined }

export function Feedback({ email, context, kinds, sent, error }: Props) {
  const embedded = parent !== window;
  if (sent) {
    return (
      <Card title="Thanks for the feedback" bare={embedded}>
        <p className={styles.note}>We read every message.</p>
        {embedded
          ? <Button type="button" onClick={() => parent.postMessage(FEEDBACK_CLOSE, location.origin)}>Close</Button>
          : <p><a href="/">Back to the app</a></p>}
      </Card>
    );
  }
  return (
    <Card title="Send feedback" wide={!embedded} bare={embedded}>
      {error && <ErrorNote>{error}</ErrorNote>}
      <form className={styles.form} method="post" action="/gw/feedback">
        {Object.entries(context).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        <Field label="Type">
          <select className={inputClass} name="kind">
            {kinds.map((k) => <option key={k} value={k}>{k[0]!.toUpperCase() + k.slice(1)}</option>)}
          </select>
        </Field>
        <Field label="Message"><textarea className={inputClass} name="message" rows={7} maxLength={4000} required /></Field>
        <p className={styles.note}>Sent as {email}.</p>
        <Button>Send</Button>
      </form>
    </Card>
  );
}
