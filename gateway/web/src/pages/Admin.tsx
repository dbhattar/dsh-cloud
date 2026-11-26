import { useEffect, useState } from 'react';
import { BrandWordmark } from '../BrandWordmark.tsx';
import { Button } from '../controls.tsx';
import styles from './Admin.module.css';

interface AuditEvent { ts: string; event: string; userId: number | null; detail: Record<string, unknown> }

const when = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
const detailText = (d: Record<string, unknown>) => Object.entries(d).map(([k, v]) => `${k}: ${String(v)}`).join(', ');

/**
 * The admin panel. Served only to admins (the server answers anyone else with "not found"). This first version is the shell and
 * what admins have done so far; the overview, users, invites and policies arrive as their own pages (docs/plan-phase-5.md, slice 5).
 */
export function Admin({ email }: { email: string }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    fetch('/gw/admin/api/audit').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then(
      (d: { events: AuditEvent[] }) => setEvents(d.events),
      () => setFailed(true),
    );
  }, []);
  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <BrandWordmark size={16} />
        <span className={styles.badge}>Admin</span>
        <a className={styles.back} href="/">Back to my workspace</a>
        <span className={styles.email}>{email}</span>
        <form method="post" action="/gw/logout"><Button variant="outline" className={styles.signout}>Sign out</Button></form>
      </header>
      <div className={styles.body}>
        <nav className={styles.nav} aria-label="Admin sections">
          <a href="/gw/admin" aria-current="page">Overview</a>
        </nav>
        <main className={styles.main}>
          <h1>Overview</h1>
          <p className={styles.lead}>You are signed in as an admin. Stats, users, invites and policies are added here one page at a time.</p>
          <h2>What admins have done</h2>
          {failed && <p className={styles.empty} role="alert">Could not load the admin log. Reload the page to try again.</p>}
          {!failed && events === null && <p className={styles.empty}>Loading…</p>}
          {events !== null && events.length === 0 && <p className={styles.empty}>Nothing yet. Granting or revoking the admin role, and creating invites, show up here.</p>}
          {events !== null && events.length > 0 && (
            <table className={styles.table}>
              <thead><tr><th>When</th><th>What</th><th>User</th><th>Details</th></tr></thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={`${e.ts}-${i}`}>
                    <td>{when(e.ts)}</td>
                    <td className={styles.mono}>{e.event}</td>
                    <td>{e.userId ?? '–'}</td>
                    <td>{detailText(e.detail)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className={styles.note}>Admins can see accounts, usage and audit rows. They cannot see the content of anyone's workspace, sessions or messages, and there is no way to sign in as another user.</p>
        </main>
      </div>
    </div>
  );
}
