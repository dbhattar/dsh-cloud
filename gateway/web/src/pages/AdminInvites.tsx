import { useCallback, useEffect, useState } from 'react';
import { whenMs } from './admin-format.ts';
import styles from './Admin.module.css';

interface Invite { id: string; note: string; createdAt: number; expiresAt: number | null; usedBy: number | null; usedByEmail: string | null; usedAt: number | null; revokedAt: number | null; status: 'valid' | 'used' | 'revoked' | 'expired' }
interface Created { code: string; link: string }

const STATUS: Record<Invite['status'], string> = { valid: 'unused', used: 'used', revoked: 'revoked', expired: 'expired' };

/** One link with a Copy button: the clipboard when the browser allows it, otherwise the text is selected for the person to copy. */
function CopyRow({ text, label, lines = 1 }: { text: string; label: string; lines?: number }) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
      setTimeout(() => setState('idle'), 2000);
    } catch {
      setState('manual');
    }
  };
  return (
    <li className={styles.linkRow}>
      {lines > 1
        ? <textarea className={styles.linkInput} readOnly rows={lines} value={text} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
        : <input className={styles.linkInput} readOnly value={text} aria-label={label} onFocus={(e) => e.currentTarget.select()} />}
      <button type="button" className={styles.smallButton} onClick={() => void copy()}>{state === 'copied' ? 'Copied' : 'Copy'}</button>
      {state === 'manual' && <span className={styles.fine}>Select the link and copy it yourself.</span>}
    </li>
  );
}

/** A button that needs a second click. */
function Confirm({ label, confirmLabel, busy, onConfirm }: { label: string; confirmLabel: string; busy: boolean; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return <button type="button" className={`${styles.smallButton} ${armed ? styles.armed : ''}`} disabled={busy} onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>{busy ? 'Working…' : armed ? confirmLabel : label}</button>;
}

/** Invites: create sign-up links (shown once), see which are unused, used, expired or revoked, and revoke an unused one. */
export function InvitesPage({ csrf }: { csrf: string }) {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState('');
  const [days, setDays] = useState('7');
  const [count, setCount] = useState('1');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Created[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(() => {
    fetch('/gw/admin/api/invites').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then(
      (d: { invites: Invite[] }) => setInvites(d.invites),
      () => setFailed(true),
    );
  }, []);
  useEffect(load, [load]);

  const post = async (path: string, body: Record<string, unknown>) => {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) });
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setMessage(null);
    try {
      const out = await post('/gw/admin/api/invites', { note, days: Number(days), count: Number(count) });
      if (out.ok) { setCreated(out.data.created as Created[]); setInvites(out.data.invites as Invite[]); setNote(''); }
      else setMessage({ kind: 'error', text: out.data?.message ?? `That did not work (${out.status}).` });
    } catch {
      setMessage({ kind: 'error', text: 'Could not reach the gateway. Try again.' });
    }
    setCreating(false);
  };

  const revoke = async (id: string) => {
    setBusy(id);
    setMessage(null);
    try {
      const out = await post(`/gw/admin/api/invites/${id}/revoke`, {});
      if (out.ok) { setInvites(out.data.invites as Invite[]); setMessage({ kind: 'ok', text: 'The invite no longer works.' }); }
      else setMessage({ kind: 'error', text: out.data?.message ?? `That did not work (${out.status}).` });
    } catch {
      setMessage({ kind: 'error', text: 'Could not reach the gateway. Try again.' });
    }
    setBusy(null);
  };

  return (
    <>
      <div className={styles.titleRow}><h1>Invites</h1></div>
      <p className={styles.lead}>Each invite is a sign-up link that works once. The link is shown only when you create it: only a fingerprint is kept, so copy it before leaving this page.</p>

      <form className={styles.inviteForm} onSubmit={(e) => void create(e)}>
        <label>Note (who it is for)<input className={styles.input} value={note} onChange={(e) => setNote(e.target.value)} maxLength={100} placeholder="optional" /></label>
        <label>Expires in (days, 0 = never)<input className={styles.input} type="number" min={0} max={365} value={days} onChange={(e) => setDays(e.target.value)} /></label>
        <label>How many<input className={styles.input} type="number" min={1} max={20} value={count} onChange={(e) => setCount(e.target.value)} /></label>
        <button type="submit" className={styles.smallButton} disabled={creating}>{creating ? 'Creating…' : 'Create invite links'}</button>
      </form>

      {created && (
        <div className={styles.confirmBox} role="status" aria-label="New invite links">
          <p><strong>{created.length === 1 ? 'Your new invite link' : `Your ${created.length} new invite links`}</strong>: copy {created.length === 1 ? 'it' : 'them'} now. {created.length === 1 ? 'It' : 'They'} will not be shown again.</p>
          <ul className={styles.linkList}>{created.map((c, i) => <CopyRow key={c.code} text={c.link} label={`Invite link ${i + 1}`} />)}</ul>
          {created.length > 1 && <CopyRow text={created.map((c) => c.link).join('\n')} label="All invite links" lines={created.length} />}
          <button type="button" className={styles.linkButton} onClick={() => setCreated(null)}>Done, hide the links</button>
        </div>
      )}
      {message && <p className={message.kind === 'ok' ? styles.okNote : styles.errNote} role={message.kind === 'ok' ? 'status' : 'alert'}>{message.text}</p>}

      <h2>All invites</h2>
      {failed && <p className={styles.empty} role="alert">Could not load the invites. Reload the page to try again.</p>}
      {!invites && !failed && <p className={styles.empty}>Loading…</p>}
      {invites && invites.length === 0 && <p className={styles.empty}>No invites yet.</p>}
      {invites && invites.length > 0 && (
        <table className={styles.table}>
          <thead><tr><th>Status</th><th>Note</th><th>Created</th><th>Expires</th><th>Used by</th><th /></tr></thead>
          <tbody>
            {invites.map((i) => (
              <tr key={i.id}>
                <td><span className={`${styles.chip} ${i.status === 'revoked' || i.status === 'expired' ? styles.chipBad : ''}`}>{STATUS[i.status]}</span></td>
                <td>{i.note || '–'}</td>
                <td>{whenMs(i.createdAt)}</td>
                <td>{i.expiresAt ? whenMs(i.expiresAt) : 'never'}</td>
                <td>{i.usedBy ? <a href={`/gw/admin/users/${i.usedBy}`}>{i.usedByEmail ?? `account ${i.usedBy}`}</a> : '–'}</td>
                <td className={styles.num}>{i.status === 'valid' && <Confirm label="Revoke" confirmLabel="Click again to revoke" busy={busy === i.id} onConfirm={() => void revoke(i.id)} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
