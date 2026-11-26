import { BrandWordmark } from '../BrandWordmark.tsx';
import { Button } from '../controls.tsx';
import { AuditPage } from './AdminAudit.tsx';
import { FeedbackPage } from './AdminFeedback.tsx';
import { InvitesPage } from './AdminInvites.tsx';
import { OverviewPage } from './AdminOverview.tsx';
import { UserPage, UsersPage } from './AdminUsers.tsx';
import styles from './Admin.module.css';

/**
 * The admin panel: the layout and a tiny router over the address (every page is its own address and a full page load, so links,
 * reload and the back button just work). Served only to admins; the server answers anyone else with "not found". The pages:
 * the overview (P5-12), accounts (P5-13), invites, feedback and the audit log (P5-14); policies follow (docs/plan-phase-5.md, slice 5).
 */
export function Admin({ email, csrf }: { email: string; csrf: string }) {
  const path = location.pathname.replace(/\/+$/, '');
  const user = /^\/gw\/admin\/users\/(\d+)$/.exec(path);
  const section = (['users', 'invites', 'feedback', 'audit'] as const).find((s) => path.startsWith(`/gw/admin/${s}`)) ?? 'overview';
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
          <a href="/gw/admin/invites" aria-current={section === 'invites' ? 'page' : undefined}>Invites</a>
          <a href="/gw/admin/feedback" aria-current={section === 'feedback' ? 'page' : undefined}>Feedback</a>
          <a href="/gw/admin/audit" aria-current={section === 'audit' ? 'page' : undefined}>Audit log</a>
        </nav>
        <main className={styles.main}>
          {user ? <UserPage id={Number(user[1])} csrf={csrf} myEmail={email} /> : section === 'users' ? <UsersPage /> : section === 'invites' ? <InvitesPage csrf={csrf} /> : section === 'feedback' ? <FeedbackPage csrf={csrf} /> : section === 'audit' ? <AuditPage /> : <OverviewPage />}
        </main>
      </div>
    </div>
  );
}
