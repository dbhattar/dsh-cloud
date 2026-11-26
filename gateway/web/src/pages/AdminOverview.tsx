import { useCallback, useEffect, useState } from 'react';
import { bytes, compact, detailText, full, plural, seconds, when } from './admin-format.ts';
import styles from './Admin.module.css';

interface AuditEvent { ts: string; event: string; userId: number | null; detail: Record<string, unknown> }
type Section<T> = ({ ok: true } & T) | { ok: false; error: string };
interface Ranked { userId: number; email: string; used: number; limit: number | null }
interface Activity { starts: number; stops: Record<string, number>; refused: Record<string, number>; startFailures: number; crashes: number; crashLoops: number; loginsOk: number; loginFailures: number; signups: number; signupFailures: number }
interface Split { samples: number; medianMs: number | null; p95Ms: number | null }
interface Check { ok: boolean; ms?: number; error?: string; freeBytes?: number; totalBytes?: number }
interface Overview {
  generatedAt: string;
  users: Section<{ total: number; admins: number; newDay: number; newWeek: number; activeDay: number; activeWeek: number }>;
  sandboxes: Section<{ running: number; total: number; capacity: number | null }>;
  tokens: Section<{ metering: false } | { metering: true; today: { tokens: number; requests: number; users: number }; monthTokens: number; series: { day: string; tokens: number; requests: number; users: number }[]; budget: { used: number; limit: number; exhausted: boolean } | null; topToday: Ranked[]; topMonth: Ranked[]; nearLimit: { userId: number; email: string; window: string; percent: number }[]; exhaustedUsers: number }>;
  storage: Section<{ totalBytes: number; limitBytes: number | null; overLimit: number; top: { userId: number; email: string; bytes: number }[] }>;
  activity: Section<{ day: Activity; week: Activity }>;
  readiness: Section<{ all: Split; resumed: Split; fresh: Split }>;
  health: { runner: Check; llmProxy: Check | null; dataDisk: Check };
  feedback: { total: number; unread: number };
}

const counts = (m: Record<string, number>) => { const e = Object.entries(m); return e.length ? e.map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ') : '–'; };

function Unavailable({ error }: { error: string }) {
  return <p className={styles.empty} role="status">Unavailable right now ({error}).</p>;
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string | undefined }) {
  return (
    <div className={styles.tile}>
      <div className={styles.tileLabel}>{label}</div>
      <div className={styles.tileValue}>{value}</div>
      {sub && <div className={styles.tileSub}>{sub}</div>}
    </div>
  );
}

/** Tokens per day: one series, so no legend; the title names it, hover or focus shows the day, and the table view has every number. */
function TokensChart({ series }: { series: { day: string; tokens: number; requests: number; users: number }[] }) {
  const [asTable, setAsTable] = useState(false);
  const [hot, setHot] = useState<number | null>(null);
  const max = Math.max(1, ...series.map((d) => d.tokens));
  const H = 140, pad = 4, gap = 2, maxW = 560;
  const bw = Math.min(36, Math.max(2, (maxW - pad * 2 - gap * (series.length - 1)) / Math.max(1, series.length)));
  const W = Math.round(pad * 2 + series.length * bw + gap * Math.max(0, series.length - 1)); // as wide as its bars, so a short series is not stretched
  const summary = `Model tokens per day, last ${series.length} days. Most: ${full.format(max === 1 && series.every((d) => d.tokens === 0) ? 0 : max)} tokens.`;
  return (
    <div className={styles.chart}>
      <div className={styles.chartHead}>
        <h2>Model tokens per day</h2>
        <button type="button" className={styles.linkButton} aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>{asTable ? 'Show chart' : 'Show as table'}</button>
      </div>
      {asTable ? (
        <table className={styles.table}>
          <thead><tr><th>Day (UTC)</th><th>Tokens</th><th>Requests</th><th>Users</th></tr></thead>
          <tbody>{[...series].reverse().map((d) => <tr key={d.day}><td>{d.day}</td><td>{full.format(d.tokens)}</td><td>{full.format(d.requests)}</td><td>{d.users}</td></tr>)}</tbody>
        </table>
      ) : (
        <div className={styles.plot}>
          <svg viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label={summary} className={styles.svg} style={{ maxWidth: W }}>
            <line x1={0} x2={W} y1={H} y2={H} className={styles.axis} />
            <text x={0} y={10} className={styles.tick}>{compact.format(max)}</text>
            {series.map((d, i) => {
              const h = Math.max(d.tokens > 0 ? 2 : 0, Math.round((d.tokens / max) * (H - 16)));
              const x = pad + i * (bw + gap);
              return (
                <g key={d.day} onMouseEnter={() => setHot(i)} onMouseLeave={() => setHot(null)} onFocus={() => setHot(i)} onBlur={() => setHot(null)} tabIndex={0} aria-label={`${d.day}: ${full.format(d.tokens)} tokens, ${d.requests} requests, ${d.users} users`}>
                  <rect x={x - gap / 2} y={0} width={bw + gap} height={H} className={styles.hit} />
                  {h > 0 && <path d={`M${x},${H} V${H - h + 3} Q${x},${H - h} ${x + 3},${H - h} H${x + bw - 3} Q${x + bw},${H - h} ${x + bw},${H - h + 3} V${H} Z`} className={hot === i ? styles.barHot : styles.bar} />}
                </g>
              );
            })}
            <text x={pad} y={H + 13} className={styles.tick}>{series[0]?.day.slice(5)}</text>
            <text x={W - pad} y={H + 13} textAnchor="end" className={styles.tick}>{series.at(-1)?.day.slice(5)}</text>
          </svg>
          {/* Always present, with a fixed height, so hovering a bar changes the text and never the layout around it. */}
          <div className={styles.tooltip} role="status" aria-live="polite">
            {hot !== null && series[hot]
              ? <><strong>{series[hot]!.day}</strong> · {full.format(series[hot]!.tokens)} tokens · {series[hot]!.requests} requests · {series[hot]!.users} {series[hot]!.users === 1 ? 'user' : 'users'}</>
              : <span className={styles.hint}>Hover or focus a bar for that day's numbers.</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function RankedTable({ title, rows, unit }: { title: string; rows: Ranked[]; unit: string }) {
  return (
    <div>
      <h3 className={styles.h3}>{title}</h3>
      {rows.length === 0 ? <p className={styles.empty}>Nobody yet.</p> : (
        <table className={styles.table}>
          <tbody>{rows.map((r) => <tr key={r.userId}><td>{r.email}</td><td className={styles.num}>{full.format(r.used)}{r.limit ? ` / ${compact.format(r.limit)}` : ''} {unit}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}

function Health({ label, c, disk = false }: { label: string; c: Check | null; disk?: boolean }) {
  if (c === null) return <li><span className={styles.dotOff} aria-hidden="true" /> {label}: not enabled</li>;
  const detail = !c.ok ? `${disk ? 'unavailable' : 'not responding'} (${c.error ?? 'error'})` : c.freeBytes !== undefined ? `${bytes(c.freeBytes)} free of ${bytes(c.totalBytes ?? 0)}` : `responding in ${c.ms} ms`;
  return <li><span className={c.ok ? styles.dotOk : styles.dotBad} aria-hidden="true" /> {label}: {c.ok ? 'ok, ' : ''}{detail}</li>;
}

function OverviewBody({ o }: { o: Overview }) {
  const u = o.users;
  const sb = o.sandboxes;
  const t = o.tokens;
  const st = o.storage;
  const r = o.readiness;
  const a = o.activity;
  const meter = t.ok && t.metering ? t : null;
  return (
    <>
      <div className={styles.tiles}>
        <Tile label="Users" value={u.ok ? full.format(u.total) : '–'} sub={u.ok ? `${u.activeDay} active today · ${u.activeWeek} this week · ${u.newWeek} new this week` : 'unavailable'} />
        <Tile label="Running now" value={sb.ok ? `${sb.running}${sb.capacity ? ` / ${sb.capacity}` : ''}` : '–'} sub={sb.ok ? `${sb.total} workspaces exist` : 'unavailable'} />
        <Tile label="Tokens today" value={meter ? compact.format(meter.today.tokens) : '–'} sub={meter ? `${meter.today.requests} requests · ${meter.today.users} users` : t.ok ? 'metering is off' : 'unavailable'} />
        <Tile label="Storage" value={st.ok ? bytes(st.totalBytes) : '–'} sub={st.ok ? (st.overLimit ? `${st.overLimit} over the limit` : 'none over the limit') : 'unavailable'} />
        <Tile label="Time to ready" value={r.ok ? seconds(r.all.medianMs) : '–'} sub={r.ok ? (r.all.samples ? `median of ${plural(r.all.samples, 'start', 'starts')} in 7 days · slowest 5%: ${seconds(r.all.p95Ms)}` : 'no starts in 7 days') : 'unavailable'} />
      </div>

      <h2>Model usage</h2>
      {!t.ok ? <Unavailable error={t.error} /> : !t.metering ? <p className={styles.empty}>Metering is not enabled on this stack.</p> : (
        <>
          <TokensChart series={t.series} />
          <p className={styles.lead}>
            {full.format(t.monthTokens)} tokens this month.
            {t.budget ? ` Shared daily budget: ${full.format(t.budget.used)} of ${full.format(t.budget.limit)}${t.budget.exhausted ? ' (used up)' : ''}.` : ' No shared daily budget is set.'}
            {t.exhaustedUsers > 0 ? ` ${t.exhaustedUsers} ${t.exhaustedUsers === 1 ? 'user has' : 'users have'} used a personal allowance.` : ''}
          </p>
          <div className={styles.cols}>
            <RankedTable title="Most tokens today" rows={t.topToday} unit="tokens" />
            <RankedTable title="Most tokens this month" rows={t.topMonth} unit="tokens" />
          </div>
          {t.nearLimit.length > 0 && (
            <>
              <h3 className={styles.h3}>Close to an allowance (80% or more)</h3>
              <table className={styles.table}><tbody>{t.nearLimit.map((n) => <tr key={n.userId}><td>{n.email}</td><td className={styles.num}>{n.percent}% of the {n.window === 'day' ? "day's" : "month's"} allowance</td></tr>)}</tbody></table>
            </>
          )}
        </>
      )}

      <h2>Storage</h2>
      {!st.ok ? <Unavailable error={st.error} /> : st.top.length === 0 ? <p className={styles.empty}>No workspaces yet.</p> : (
        <table className={styles.table}><tbody>{st.top.map((x) => <tr key={x.userId}><td>{x.email}</td><td className={styles.num}>{bytes(x.bytes)}{st.limitBytes ? ` of ${bytes(st.limitBytes)}` : ''}</td></tr>)}</tbody></table>
      )}

      <h2>What happened</h2>
      {!a.ok ? <Unavailable error={a.error} /> : (
        <table className={styles.table}>
          <thead><tr><th></th><th>Last 24 hours</th><th>Last 7 days</th></tr></thead>
          <tbody>
            <tr><td>Workspace starts</td><td>{a.day.starts}</td><td>{a.week.starts}</td></tr>
            <tr><td>Starts that failed</td><td>{a.day.startFailures}</td><td>{a.week.startFailures}</td></tr>
            <tr><td>Refused (why)</td><td>{counts(a.day.refused)}</td><td>{counts(a.week.refused)}</td></tr>
            <tr><td>Stopped (why)</td><td>{counts(a.day.stops)}</td><td>{counts(a.week.stops)}</td></tr>
            <tr><td>Crashes · crash loops</td><td>{a.day.crashes} · {a.day.crashLoops}</td><td>{a.week.crashes} · {a.week.crashLoops}</td></tr>
            <tr><td>Sign-ins · failed</td><td>{a.day.loginsOk} · {a.day.loginFailures}</td><td>{a.week.loginsOk} · {a.week.loginFailures}</td></tr>
            <tr><td>Sign-ups · failed</td><td>{a.day.signups} · {a.day.signupFailures}</td><td>{a.week.signups} · {a.week.signupFailures}</td></tr>
          </tbody>
        </table>
      )}
      {r.ok && r.all.samples > 0 && (
        <p className={styles.lead}>Time to ready, median: {seconds(r.resumed.medianMs)} for a stopped workspace waking up ({plural(r.resumed.samples, 'start', 'starts')}), {seconds(r.fresh.medianMs)} for a first start ({plural(r.fresh.samples, 'start', 'starts')}).</p>
      )}

      <h2>Services</h2>
      <ul className={styles.health}>
        <Health label="Workspace runner" c={o.health.runner} />
        <Health label="Model proxy" c={o.health.llmProxy} />
        <Health label="Gateway data disk" c={o.health.dataDisk} disk />
      </ul>
      <p className={styles.lead}>{plural(o.feedback.total, 'piece', 'pieces')} of feedback received so far{o.feedback.unread > 0 ? <>, <a href="/gw/admin/feedback">{o.feedback.unread} unread</a></> : ''}.</p>
    </>
  );
}

/** The overview page: numbers from what is already recorded (docs/plan-phase-5.md, P5-12) and what admins have done. */
export function OverviewPage() {
  const [o, setO] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const load = useCallback(() => {
    setLoading(true);
    fetch('/gw/admin/api/overview').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then(
      (d: Overview) => { setO(d); setFailed(false); setLoading(false); },
      () => { setFailed(true); setLoading(false); },
    );
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    fetch('/gw/admin/api/audit').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then((d: { events: AuditEvent[] }) => setEvents(d.events), () => setEvents([]));
  }, []);
  return (
    <>
          <div className={styles.titleRow}>
            <h1>Overview</h1>
            <span className={styles.stamp}>{o ? `Updated ${when(o.generatedAt)}` : ''}</span>
            <button type="button" className={styles.linkButton} onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
          </div>
          {failed && <p className={styles.empty} role="alert">Could not load the overview. Refresh to try again.</p>}
          {!o && !failed && <p className={styles.empty}>Loading…</p>}
          {o && <OverviewBody o={o} />}

          <h2>What admins have done</h2>
          {events === null && <p className={styles.empty}>Loading…</p>}
          {events !== null && events.length === 0 && <p className={styles.empty}>Nothing yet. Granting or revoking the admin role, and creating invites, show up here.</p>}
          {events !== null && events.length > 0 && (
            <table className={styles.table}>
              <thead><tr><th>When</th><th>What</th><th>User</th><th>Details</th></tr></thead>
              <tbody>
                {events.slice(0, 10).map((e, i) => (
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
          {events !== null && events.length > 10 && <p className={styles.empty}>Showing the latest 10 of {events.length}. The rest is in the <a href="/gw/admin/audit?event=admin.&since=all">audit search</a>.</p>}
          <p className={styles.note}>Admins can see accounts, usage and audit rows. They cannot see the content of anyone's workspace, sessions or messages, and there is no way to sign in as another user.</p>
    </>
  );
}
