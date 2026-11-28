import { useCallback, useEffect, useState } from 'react';
import { whenMs } from './admin-format.ts';
import styles from './Admin.module.css';

interface Entry { email: string; joinedAt: number; confirmedAt: number | null; invitedAt: number | null }

/** The waitlist: who asked for a place, who confirmed their address, and a button to invite one by email. */
export function WaitlistPage({ csrf }: { csrf: string }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [mailEnabled, setMailEnabled] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(() => {
    fetch('/gw/admin/api/waitlist').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then(
      (d: { entries: Entry[]; mailEnabled: boolean }) => { setEntries(d.entries); setMailEnabled(d.mailEnabled); },
      () => setFailed(true),
    );
  }, []);
  useEffect(load, [load]);

  const act = async (path: string, email: string, okText: string) => {
    setBusy(email);
    setMessage(null);
    try {
      const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ email }) });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        setEntries(data.entries as Entry[]);
        const sent = data.sent as { queued: boolean; reason?: string } | undefined;
        setMessage(sent && !sent.queued ? { kind: 'error', text: `Not sent (${sent.reason === 'rate_limited' ? 'too many messages to that address or in this hour' : 'the mail queue is full'}). Try again later.` } : { kind: 'ok', text: okText });
      } else setMessage({ kind: 'error', text: data?.message ?? `That did not work (${r.status}).` });
    } catch {
      setMessage({ kind: 'error', text: 'Could not reach the gateway. Try again.' });
    }
    setBusy(null);
  };

  const waiting = entries?.filter((e) => !e.invitedAt).length ?? 0;
  return (
    <section aria-labelledby="waitlist-h">
      <h1 id="waitlist-h">Waitlist</h1>
      <p className={styles.lead}>People who asked for a place on the sign-in page. {mailEnabled ? 'They are asked to confirm their address first, and only confirmed addresses can be invited. Inviting sends a sign-up link by email.' : 'Email is not set up on this server (MAIL_PROVIDER), so nobody is asked to confirm and invitations cannot be mailed from here: create an invite on the Invites page and send it yourself.'}</p>
      {message && <p className={message.kind === 'ok' ? styles.okNote : styles.errNote} role={message.kind === 'ok' ? 'status' : 'alert'}>{message.text}</p>}
      {failed && <p className={styles.empty} role="alert">Could not load the waitlist. Reload the page to try again.</p>}
      {entries && entries.length === 0 && <p className={styles.empty}>Nobody is waiting.</p>}
      {entries && entries.length > 0 && (
        <>
          <p className={styles.fine}>{waiting} waiting, {entries.length - waiting} invited. Oldest first.</p>
          <table className={styles.table}>
            <thead><tr><th>Email</th><th>Asked</th><th>Address</th><th>Status</th><th><span className={styles.srOnly}>Actions</span></th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.email}>
                  <td>{e.email}</td>
                  <td>{whenMs(e.joinedAt)}</td>
                  <td>{e.confirmedAt ? `confirmed ${whenMs(e.confirmedAt)}` : 'not confirmed'}</td>
                  <td>{e.invitedAt ? `invited ${whenMs(e.invitedAt)}` : 'waiting'}</td>
                  <td>
                    <button type="button" className={styles.smallButton} disabled={busy === e.email || !mailEnabled || !e.confirmedAt} title={!mailEnabled ? 'Email is not set up' : !e.confirmedAt ? 'Not confirmed yet' : undefined} onClick={() => void act('/gw/admin/api/waitlist/invite', e.email, `The invitation to ${e.email} is on its way.`)}>{e.invitedAt ? 'Invite again' : 'Invite'}</button>{' '}
                    <button type="button" className={styles.smallButton} disabled={busy === e.email} onClick={() => void act('/gw/admin/api/waitlist/remove', e.email, `${e.email} was removed.`)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
