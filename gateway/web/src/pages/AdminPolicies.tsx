import { useCallback, useEffect, useState } from 'react';
import { compact, full, whenMs } from './admin-format.ts';
import styles from './Admin.module.css';

interface Setting {
  scope: 'gateway' | 'proxy';
  key: string;
  group: string;
  label: string;
  description: string;
  type: 'int' | 'bool';
  unit?: string;
  min?: number;
  max?: number;
  zero?: string;
  confirmWhen?: boolean;
  confirmText?: string;
  applies: string;
  default: number | boolean;
  value: number | boolean;
  source: 'default' | 'admin';
  updatedAt: number | null;
  updatedBy?: number | null;
}
interface Recent { ts: string; event: string; detail: Record<string, unknown> }
interface Data { settings: Setting[]; proxy: { ok: boolean | null; error?: string }; recent: Recent[] }

/** "1800 seconds" as "30 minutes", for the hint under a time input. */
function span(seconds: number): string {
  if (seconds >= 86400) { const d = Math.round((seconds / 86400) * 10) / 10; return `${d} ${d === 1 ? 'day' : 'days'}`; }
  if (seconds >= 3600) { const h = Math.round((seconds / 3600) * 10) / 10; return `${h} ${h === 1 ? 'hour' : 'hours'}`; }
  if (seconds >= 60) { const m = Math.round(seconds / 6) / 10; return `${m} ${m === 1 ? 'minute' : 'minutes'}`; }
  return `${seconds} seconds`;
}
const shown = (s: Setting, v: number | boolean): string => {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (v === 0 && s.zero) return `0 (${s.zero})`;
  if (s.unit === 'seconds') return `${full.format(v)} s (${span(v)})`;
  if (s.unit === 'tokens') return v >= 1000 ? `${full.format(v)} (${compact.format(v)})` : full.format(v);
  return `${full.format(v)}${s.unit ? ` ${s.unit}` : ''}`;
};

function Row({ s, csrf, onSaved }: { s: Setting; csrf: string; onSaved: (d: Data) => void }) {
  const initial = typeof s.value === 'boolean' ? (s.value ? 'on' : 'off') : String(s.value);
  const [draft, setDraft] = useState(initial);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null);
  const [armed, setArmed] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  useEffect(() => { setDraft(initial); setConfirm(false); }, [initial]);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  const isBool = s.type === 'bool';
  const proposed: number | boolean | null = isBool ? draft === 'on' : /^\d{1,12}$/.test(draft.trim()) ? Number(draft.trim()) : null;
  const dirty = draft !== initial;
  // What needs an explicit yes: turning a limit off (0), or opening something up.
  const needsYes = isBool ? proposed === s.confirmWhen : proposed === 0 && Boolean(s.zero);
  const yesText = isBool ? s.confirmText : `Turn this limit off: 0 means ${s.zero}.`;

  const send = async (path: string, body: Record<string, unknown>, kind: 'save' | 'reset') => {
    setBusy(kind);
    setMsg(null);
    try {
      const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) });
      const out = await r.json().catch(() => ({}));
      if (r.ok) { onSaved(out as Data); setMsg({ kind: 'ok', text: kind === 'save' ? 'Saved. It applies as described above.' : 'Back to the default.' }); }
      else setMsg({ kind: 'error', text: out?.message ?? `That did not work (${r.status}).` });
    } catch {
      setMsg({ kind: 'error', text: 'Could not reach the gateway. Try again.' });
    }
    setBusy(null);
  };

  const id = `p-${s.key}`;
  return (
    <li className={styles.policy}>
      <div className={styles.policyHead}>
        <label htmlFor={id}><strong>{s.label}</strong></label>
        <span className={`${styles.chip} ${s.source === 'admin' ? styles.chipChanged : ''}`}>{s.source === 'admin' ? 'changed here' : 'default'}</span>
      </div>
      <p className={styles.policyText}>{s.description}</p>
      <div className={styles.policyControls}>
        {isBool ? (
          <select id={id} className={styles.input} value={draft} onChange={(e) => { setDraft(e.target.value); setConfirm(false); }}>
            <option value="off">Off</option>
            <option value="on">On</option>
          </select>
        ) : (
          <>
            <input id={id} className={styles.input} inputMode="numeric" value={draft} onChange={(e) => { setDraft(e.target.value); setConfirm(false); }} aria-describedby={`${id}-hint`} />
            <span className={styles.unit}>{s.unit}</span>
          </>
        )}
        <button type="button" className={styles.smallButton} disabled={!dirty || proposed === null || busy !== null || (needsYes && !confirm)} onClick={() => void send(`/gw/admin/api/policies/${s.key}`, { value: proposed, ...(needsYes ? { confirm: true } : {}) }, 'save')}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        {s.source === 'admin' && (
          <button type="button" className={`${styles.smallButton} ${armed ? styles.armed : ''}`} disabled={busy !== null} onClick={() => { if (armed) { setArmed(false); void send(`/gw/admin/api/policies/${s.key}/reset`, {}, 'reset'); } else setArmed(true); }}>{busy === 'reset' ? 'Resetting…' : armed ? 'Click again to reset' : 'Reset to default'}</button>
        )}
      </div>
      <p id={`${id}-hint`} className={styles.fine}>
        {dirty && !isBool && proposed !== null ? `That is ${shown(s, proposed)}. ` : ''}
        Now {shown(s, s.value)}. Default {shown(s, s.default)}{s.min !== undefined && !isBool ? `; allowed ${s.zero ? `0 or ` : ''}${full.format(s.min)} to ${full.format(s.max ?? 0)}` : ''}. {s.applies}.
        {s.source === 'admin' && s.updatedAt ? ` Changed ${whenMs(s.updatedAt)}${s.updatedBy ? ` by account ${s.updatedBy}` : ''}.` : ''}
      </p>
      {dirty && needsYes && (
        <label className={styles.yes}><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> {yesText}</label>
      )}
      {msg && <p className={msg.kind === 'ok' ? styles.okNote : styles.errNote} role={msg.kind === 'ok' ? 'status' : 'alert'}>{msg.text}</p>}
    </li>
  );
}

const describe = (r: Recent, labels: Map<string, string>) => {
  const d = r.detail as { key?: string; from?: unknown; to?: unknown; by?: unknown };
  return `${labels.get(d.key ?? '') ?? d.key ?? '?'}: ${String(d.from)} → ${String(d.to)}${r.event.endsWith('reset') ? ' (reset to default)' : ''}, by account ${String(d.by ?? '?')}`;
};

/** The settings an admin may change, in groups, each with its value, where it comes from, when it applies, and Save and Reset. */
export function PoliciesPage({ csrf }: { csrf: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    fetch('/gw/admin/api/policies').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then((d: Data) => setData(d), () => setFailed(true));
  }, []);
  useEffect(load, [load]);
  const groups = data ? [...new Set(data.settings.map((s) => s.group))] : [];
  return (
    <>
      <div className={styles.titleRow}><h1>Policies</h1></div>
      <p className={styles.lead}>The limits and rules the service runs by. A value starts as the server's configuration (the default); a change made here applies without a restart and survives one. Reset puts the default back. Secrets, the model list and the sandbox's security settings are not editable here.</p>
      {failed && <p className={styles.empty} role="alert">Could not load the settings. Reload the page to try again.</p>}
      {!data && !failed && <p className={styles.empty}>Loading…</p>}
      {data && data.proxy.ok === false && <p className={styles.errNote} role="status">{data.proxy.error}</p>}
      {data && groups.map((g) => (
        <section key={g} aria-labelledby={`g-${g.replace(/\W+/g, '-')}`}>
          <h2 id={`g-${g.replace(/\W+/g, '-')}`}>{g}</h2>
          <ul className={styles.policyList}>
            {data.settings.filter((s) => s.group === g).map((s) => <Row key={s.key} s={s} csrf={csrf} onSaved={setData} />)}
          </ul>
        </section>
      ))}
      {data && (
        <>
          <h2>Recent changes</h2>
          {data.recent.length === 0 ? <p className={styles.empty}>No changes yet.</p> : (
            <table className={styles.table}><tbody>{data.recent.map((r, i) => <tr key={`${r.ts}-${i}`}><td>{whenMs(Date.parse(r.ts))}</td><td>{describe(r, new Map(data.settings.map((s) => [s.key, s.label])))}</td></tr>)}</tbody></table>
          )}
          <p className={styles.fine}>The full history is in the <a href="/gw/admin/audit?event=admin.policy*&since=all">audit log</a>.</p>
        </>
      )}
    </>
  );
}
