import { useCallback, useEffect, useState } from 'react';
import { bytes, compact, detailText, full, plural, when, whenMs } from './admin-format.ts';
import styles from './Admin.module.css';

interface Sandbox { state: 'running' | 'stopped' | 'none' | null; held: { code: string; title: string } | null; startedAt?: string | null; reachable?: boolean }
interface Account { id: number; email: string; createdAt: number; isAdmin: boolean; suspendedAt: number | null; lastActive: number | null }
interface Row extends Account { sandbox: Sandbox; tokens: { day: number; month: number; exhausted: boolean } | null; storageBytes: number | null }
interface List { total: number; page: number; pageSize: number; sources: { runner: boolean; proxy: boolean | null; storage: boolean }; users: Row[] }
interface Meter { used: number; limit: number | null }
interface Detail {
  account: Account;
  sandbox: Sandbox;
  usage: { day: Meter; month: Meter; exhausted: boolean } | null;
  storageBytes: number | null;
  audit: { ts: string; event: string; ip: string | null; detail: Record<string, unknown> }[];
  feedback: { id: number; kind: string; message: string; createdAt: number }[];
}

const stateText = (s: Sandbox) => (s.state === null ? 'unknown' : s.state === 'none' ? 'no workspace yet' : s.state);
const limitText = (m: Meter) => `${full.format(m.used)}${m.limit ? ` of ${compact.format(m.limit)}` : ''}`;

/** Accounts: a searchable list, 25 to a page. Search and paging are plain links and a GET form, so every view has an address. */
export function UsersPage() {
  const params = new URLSearchParams(location.search);
  const q = params.get('q') ?? '';
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const [data, setData] = useState<List | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    fetch(`/gw/admin/api/users?${new URLSearchParams({ q, page: String(page) })}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then(
      (d: List) => setData(d),
      () => setFailed(true),
    );
  }, [q, page]);
  const link = (p: number) => `/gw/admin/users?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`;
  const last = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <>
      <div className={styles.titleRow}><h1>Users</h1><span className={styles.stamp}>{data ? plural(data.total, 'account', 'accounts') : ''}</span></div>
      <form method="get" action="/gw/admin/users" role="search" className={styles.search}>
        <label className={styles.srOnly} htmlFor="user-search">Search by email</label>
        <input id="user-search" type="search" name="q" defaultValue={q} placeholder="Search by email" className={styles.input} autoComplete="off" />
        <button type="submit" className={styles.smallButton}>Search</button>
        {q && <a className={styles.linkButton} href="/gw/admin/users">Clear</a>}
      </form>
      {failed && <p className={styles.empty} role="alert">Could not load the accounts. Reload the page to try again.</p>}
      {!data && !failed && <p className={styles.empty}>Loading…</p>}
      {data && (data.sources.runner === false || data.sources.proxy === false) && (
        <p className={styles.empty} role="status">{[data.sources.runner === false && 'The workspace runner', data.sources.proxy === false && 'The model proxy'].filter(Boolean).join(' and ')} could not be reached, so some columns are blank.</p>
      )}
      {data && data.users.length === 0 && <p className={styles.empty}>{q ? `No account matches "${q}".` : 'No accounts yet.'}</p>}
      {data && data.users.length > 0 && (
        <table className={styles.table}>
          <thead><tr><th>Account</th><th>Workspace</th><th>Last active</th><th className={styles.num}>Tokens today</th><th className={styles.num}>Storage</th></tr></thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.id}>
                <td>
                  <a href={`/gw/admin/users/${u.id}`}>{u.email}</a>
                  {u.isAdmin && <span className={styles.chip}>admin</span>}
                  {u.suspendedAt && <span className={`${styles.chip} ${styles.chipBad}`}>suspended</span>}
                </td>
                <td>{stateText(u.sandbox)}{u.sandbox.held && <span className={styles.chip} title={u.sandbox.held.title}>held</span>}</td>
                <td>{u.lastActive ? whenMs(u.lastActive) : 'never'}</td>
                <td className={styles.num}>{u.tokens ? full.format(u.tokens.day) : '–'}</td>
                <td className={styles.num}>{u.storageBytes === null ? '–' : bytes(u.storageBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && last > 1 && (
        <nav className={styles.pager} aria-label="Pages">
          {page > 1 ? <a href={link(page - 1)}>Previous</a> : <span />}
          <span>Page {page} of {last}</span>
          {page < last ? <a href={link(page + 1)}>Next</a> : <span />}
        </nav>
      )}
    </>
  );
}

type Action = 'stop' | 'restart' | 'signout' | 'suspend' | 'unsuspend';

/** A button that needs a second click, so a stray click does nothing. */
function Confirm({ label, confirmLabel, busy, disabled, onConfirm }: { label: string; confirmLabel: string; busy: boolean; disabled?: boolean | undefined; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button type="button" className={`${styles.smallButton} ${armed ? styles.armed : ''}`} disabled={busy || disabled} onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      {busy ? 'Working…' : armed ? confirmLabel : label}
    </button>
  );
}

/** One account: state, usage, what it did lately, what it sent us, and the actions an admin may take. */
export function UserPage({ id, csrf, myEmail }: { id: number; csrf: string; myEmail: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<Action | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [typed, setTyped] = useState('');
  const [suspending, setSuspending] = useState(false);
  const load = useCallback(() => {
    fetch(`/gw/admin/api/users/${id}`).then((r) => (r.status === 404 ? Promise.reject(new Error('404')) : r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then(
      (x: Detail) => setD(x),
      (e: Error) => (e.message === '404' ? setMissing(true) : setFailed(true)),
    );
  }, [id]);
  useEffect(load, [load]);

  const run = async (action: Action, body: Record<string, unknown> = {}, done: string) => {
    setBusy(action);
    setMessage(null);
    try {
      const r = await fetch(`/gw/admin/api/users/${id}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) });
      const out = await r.json().catch(() => ({}));
      if (r.ok) { setD(out as Detail); setMessage({ kind: 'ok', text: done }); setSuspending(false); setTyped(''); }
      else {
        if (out?.detail) setD(out.detail as Detail); // a partly done suspension: show what state it is in now
        setMessage({ kind: 'error', text: out?.message ?? `That did not work (${r.status}).` });
      }
    } catch {
      setMessage({ kind: 'error', text: 'Could not reach the gateway. Try again.' });
    }
    setBusy(null);
  };

  if (missing) return <><h1>No such account</h1><p className={styles.lead}>There is no account with number {id}. <a href="/gw/admin/users">Back to the list</a></p></>;
  if (failed) return <p className={styles.empty} role="alert">Could not load the account. Reload the page to try again.</p>;
  if (!d) return <p className={styles.empty}>Loading…</p>;
  const a = d.account;
  const suspended = a.suspendedAt !== null;
  const self = a.email.toLowerCase() === myEmail.toLowerCase();
  return (
    <>
      <p className={styles.crumb}><a href="/gw/admin/users">Users</a> / {a.email}</p>
      <div className={styles.titleRow}>
        <h1>{a.email}</h1>
        {a.isAdmin && <span className={styles.chip}>admin</span>}
        {suspended && <span className={`${styles.chip} ${styles.chipBad}`}>suspended</span>}
        <button type="button" className={`${styles.linkButton} ${styles.push}`} onClick={load}>Refresh</button>
      </div>
      <p className={styles.lead}>
        Account {a.id}, created {whenMs(a.createdAt)}.{' '}
        {a.lastActive ? `Last active ${whenMs(a.lastActive)}.` : 'Has not been active yet.'}
        {suspended && ` Suspended ${whenMs(a.suspendedAt!)}: it cannot sign in and its workspace is stopped.`}
      </p>

      <h2>Workspace and usage</h2>
      <dl className={styles.facts}>
        <dt>Workspace</dt>
        <dd>{stateText(d.sandbox)}{d.sandbox.startedAt ? `, running since ${when(d.sandbox.startedAt)}` : ''}{d.sandbox.held ? `. Held: ${d.sandbox.held.title}` : ''}</dd>
        <dt>Model tokens today</dt>
        <dd>{d.usage ? limitText(d.usage.day) : 'not available'}</dd>
        <dt>Model tokens this month</dt>
        <dd>{d.usage ? limitText(d.usage.month) : 'not available'}</dd>
        <dt>Storage</dt>
        <dd>{d.storageBytes === null ? 'not available' : bytes(d.storageBytes)}</dd>
      </dl>

      <h2>Actions</h2>
      <div className={styles.actions} role="group" aria-label="Actions on this account">
        <Confirm label="Stop workspace" confirmLabel="Click again to stop" busy={busy === 'stop'} disabled={suspended} onConfirm={() => void run('stop', {}, 'The workspace was stopped. The person sees why and can start it again.')} />
        <Confirm label="Restart workspace" confirmLabel="Click again to restart" busy={busy === 'restart'} disabled={suspended} onConfirm={() => void run('restart', {}, 'The workspace is restarting.')} />
        <Confirm label="Sign out everywhere" confirmLabel="Click again to sign out" busy={busy === 'signout'} onConfirm={() => void run('signout', {}, 'Every session of this account has ended.')} />
        {suspended
          ? <Confirm label="Lift the suspension" confirmLabel="Click again to lift it" busy={busy === 'unsuspend'} onConfirm={() => void run('unsuspend', {}, 'The suspension is lifted. They can sign in again.')} />
          : !a.isAdmin && <button type="button" className={`${styles.smallButton} ${styles.danger}`} onClick={() => setSuspending((v) => !v)} aria-expanded={suspending}>Suspend…</button>}
      </div>
      {a.isAdmin && !suspended && <p className={styles.fine}>{self ? 'This is you. ' : ''}Admins cannot be suspended here: take the role away first with <code>scripts/make-admin.sh --revoke</code>.</p>}
      {suspending && !suspended && !a.isAdmin && (
        <form className={styles.confirmBox} onSubmit={(e) => { e.preventDefault(); void run('suspend', { confirm: typed }, 'The account is suspended.'); }}>
          <p>Suspending signs {a.email} out, stops their workspace, cuts off model access and refuses their sign-in. Their files are kept. To confirm, type the email address.</p>
          <label className={styles.srOnly} htmlFor="confirm-email">Type the account's email to confirm</label>
          <input id="confirm-email" className={styles.input} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={a.email} autoComplete="off" />
          <button type="submit" className={`${styles.smallButton} ${styles.danger}`} disabled={busy === 'suspend' || typed.trim().toLowerCase() !== a.email.toLowerCase()}>{busy === 'suspend' ? 'Working…' : 'Suspend this account'}</button>
        </form>
      )}
      {message && <p className={message.kind === 'ok' ? styles.okNote : styles.errNote} role={message.kind === 'ok' ? 'status' : 'alert'}>{message.text}</p>}

      <h2>Feedback they sent</h2>
      {d.feedback.length === 0 ? <p className={styles.empty}>None.</p> : (
        <ul className={styles.feedback}>{d.feedback.map((f) => <li key={f.id}><strong>{f.kind}</strong> · {whenMs(f.createdAt)}<br />{f.message}</li>)}</ul>
      )}

      <h2>Recent activity</h2>
      {d.audit.length === 0 ? <p className={styles.empty}>Nothing recorded yet.</p> : (
        <table className={styles.table}>
          <thead><tr><th>When</th><th>What</th><th>From</th><th>Details</th></tr></thead>
          <tbody>{d.audit.map((e, i) => <tr key={`${e.ts}-${i}`}><td>{when(e.ts)}</td><td className={styles.mono}>{e.event}</td><td>{e.ip ?? '–'}</td><td>{detailText(e.detail)}</td></tr>)}</tbody>
        </table>
      )}
      <p className={styles.note}>You can see the account, its usage, its audit rows and the feedback it sent to us. The content of its workspace, sessions and messages is not visible here, and there is no way to sign in as this user.</p>
    </>
  );
}
