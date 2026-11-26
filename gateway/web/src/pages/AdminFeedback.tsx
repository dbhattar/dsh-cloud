import { useEffect, useState } from 'react';
import { whenMs } from './admin-format.ts';
import styles from './Admin.module.css';

interface Item { id: number; userId: number; email: string | null; kind: string; message: string; createdAt: number; readAt: number | null }
interface Data { rows: Item[]; total: number; page: number; pageSize: number; counts: { total: number; unread: number }; status: 'unread' | 'all' }

/** The feedback people sent through the form: unread first, mark each read when it has been dealt with. */
export function FeedbackPage({ csrf }: { csrf: string }) {
  const params = new URLSearchParams(location.search);
  const status = params.get('status') === 'all' ? 'all' : 'unread';
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/gw/admin/api/feedback?${new URLSearchParams({ status, page: String(page) })}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then(
      (d: Data) => setData(d),
      () => setFailed(true),
    );
  }, [status, page]);

  const mark = async (item: Item, read: boolean) => {
    setBusy(item.id);
    setError(null);
    try {
      const r = await fetch(`/gw/admin/api/feedback/${item.id}/read`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ read }) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) setError(out?.message ?? `That did not work (${r.status}).`);
      else setData((d) => d && {
        ...d,
        counts: out.counts,
        // In the unread view a read item leaves the list; elsewhere it just changes state.
        rows: d.status === 'unread' && read ? d.rows.filter((x) => x.id !== item.id) : d.rows.map((x) => (x.id === item.id ? { ...x, readAt: read ? Date.now() : null } : x)),
        total: d.status === 'unread' && read ? d.total - 1 : d.total,
      });
    } catch {
      setError('Could not reach the gateway. Try again.');
    }
    setBusy(null);
  };

  const last = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const link = (p: number, s = status) => `/gw/admin/feedback?${new URLSearchParams({ ...(s === 'all' ? { status: 'all' } : {}), page: String(p) })}`;
  return (
    <>
      <div className={styles.titleRow}><h1>Feedback</h1><span className={styles.stamp}>{data ? `${data.counts.unread} unread of ${data.counts.total}` : ''}</span></div>
      <nav className={styles.tabs} aria-label="Which feedback">
        <a href={link(1, 'unread')} aria-current={status === 'unread' ? 'page' : undefined}>Unread</a>
        <a href={link(1, 'all')} aria-current={status === 'all' ? 'page' : undefined}>All</a>
      </nav>
      {failed && <p className={styles.empty} role="alert">Could not load the feedback. Reload the page to try again.</p>}
      {!data && !failed && <p className={styles.empty}>Loading…</p>}
      {error && <p className={styles.errNote} role="alert">{error}</p>}
      {data && data.rows.length === 0 && <p className={styles.empty}>{status === 'unread' ? 'Nothing unread. Nice.' : 'No feedback yet.'}</p>}
      {data && data.rows.length > 0 && (
        <ul className={styles.feedbackList}>
          {data.rows.map((f) => (
            <li key={f.id} className={f.readAt ? styles.feedbackRead : undefined}>
              <div className={styles.feedbackHead}>
                <strong>{f.kind}</strong>
                <span>{whenMs(f.createdAt)}</span>
                <a href={`/gw/admin/users/${f.userId}`}>{f.email ?? `account ${f.userId}`}</a>
                <button type="button" className={styles.smallButton} disabled={busy === f.id} onClick={() => void mark(f, !f.readAt)}>{f.readAt ? 'Mark unread' : 'Mark read'}</button>
              </div>
              <p className={styles.feedbackText}>{f.message}</p>
            </li>
          ))}
        </ul>
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
