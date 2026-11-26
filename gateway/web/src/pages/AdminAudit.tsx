import { useEffect, useState } from 'react';
import { detailText, when } from './admin-format.ts';
import styles from './Admin.module.css';

interface Row { id: number; ts: string; event: string; userId: number | null; ip: string | null; detail: Record<string, unknown> }
interface Result { rows: Row[]; next: number | null; limit: number }

const SINCE = [['1h', 'Last hour'], ['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['all', 'All of it']] as const;

/** Audit search with the same filters as scripts/audit.sh, paged by the last row seen, and the same filters as a CSV download. */
export function AuditPage() {
  const params = new URLSearchParams(location.search);
  const user = params.get('user') ?? '';
  const event = params.get('event') ?? '';
  const since = params.get('since') ?? '24h';
  const before = params.get('before') ?? '';
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filters = new URLSearchParams({ ...(user ? { user } : {}), ...(event ? { event } : {}), since });
  useEffect(() => {
    fetch(`/gw/admin/api/audit/search?${new URLSearchParams({ ...Object.fromEntries(filters), ...(before ? { before } : {}) })}`).then(async (r) => {
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out?.message ?? `The search failed (${r.status}).`);
      setData(out as Result);
    }).catch((e: Error) => setError(e.message));
  }, [user, event, since, before]);
  const older = data?.next ? `/gw/admin/audit?${new URLSearchParams({ ...Object.fromEntries(filters), before: String(data.next) })}` : null;
  return (
    <>
      <div className={styles.titleRow}><h1>Audit log</h1></div>
      <p className={styles.lead}>Who did what and when. Counts and identifiers only: never passwords, tokens, invite codes or the content of anyone's work.</p>
      <form method="get" action="/gw/admin/audit" className={styles.auditForm} role="search">
        <label>Account number<input className={styles.input} name="user" defaultValue={user} inputMode="numeric" placeholder="any" /></label>
        <label>Event (a name, or a start such as sandbox.)<input className={styles.input} name="event" defaultValue={event} placeholder="any" /></label>
        <label>Since<select className={styles.input} name="since" defaultValue={since}>{SINCE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <button type="submit" className={styles.smallButton}>Search</button>
        <a className={styles.linkButton} href={`/gw/admin/api/audit/export?${filters}`} download>Download as CSV</a>
      </form>
      {error && <p className={styles.errNote} role="alert">{error}</p>}
      {!data && !error && <p className={styles.empty}>Loading…</p>}
      {data && data.rows.length === 0 && <p className={styles.empty}>No rows match.</p>}
      {data && data.rows.length > 0 && (
        <table className={styles.table}>
          <thead><tr><th>When</th><th>What</th><th>User</th><th>From</th><th>Details</th></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id}>
                <td>{when(r.ts)}</td>
                <td className={styles.mono}>{r.event}</td>
                <td>{r.userId ? <a href={`/gw/admin/users/${r.userId}`}>{r.userId}</a> : '–'}</td>
                <td>{r.ip ?? '–'}</td>
                <td>{detailText(r.detail)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {older && <nav className={styles.pager} aria-label="Pages"><span /><a href={older}>Older rows</a></nav>}
      <p className={styles.fine}>The CSV holds up to 5000 rows of the same search, and downloading it is itself recorded here.</p>
    </>
  );
}
