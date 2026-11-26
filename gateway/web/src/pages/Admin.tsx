import { BrandWordmark } from '../BrandWordmark.tsx';
import { Button } from '../controls.tsx';
import { OverviewPage } from './AdminOverview.tsx';
import { UserPage, UsersPage } from './AdminUsers.tsx';
import styles from './Admin.module.css';

/**
 * The admin panel: the layout and a tiny router over the address (every page is its own address and a full page load, so links,
 * reload and the back button just work). Served only to admins; the server answers anyone else with "not found". The pages:
 * the overview (P5-12) and accounts (P5-13); invites, audit search and policies follow (docs/plan-phase-5.md, slice 5).
 */
export function Admin({ email, csrf }: { email: string; csrf: string }) {
  const path = location.pathname.replace(/\/+$/, '');
  const user = /^\/gw\/admin\/users\/(\d+)$/.exec(path);
  const section = path.startsWith('/gw/admin/users') ? 'users' : 'overview';
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
          <a href="/gw/admin" aria-current={section === 'overview' ? 'page' : undefined}>Overview</a>
          <a href="/gw/admin/users" aria-current={section === 'users' ? 'page' : undefined}>Users</a>
        </nav>
        <main className={styles.main}>
          {user ? <UserPage id={Number(user[1])} csrf={csrf} myEmail={email} /> : section === 'users' ? <UsersPage /> : <OverviewPage />}
        </main>
      </div>
    </div>
  );
}
