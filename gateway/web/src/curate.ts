/**
 * Small, deliberate edits to the harness page shown in the workspace frame. The harness is a separate product with its own
 * words, and a few of them confuse people here: a "DSH Local Build" label with a build id under it, a "Preview" badge, and the
 * headline "Into the Unknown". The frame is same-origin, so the shell can reach its document. This works from what the harness
 * renders (class names end in a readable name after a build hash, for example `htUHuG_buildVersion`), so it is deliberately
 * narrow: hide two things, rename two. If the harness changes its markup the edits simply stop applying and the page falls
 * back to the harness's own wording; tests/phase5/welcome.test.mjs notices.
 */

const DEFAULT_HEADLINE = 'Into the Unknown';

const STYLE = `
[class*="_buildVersion"], [class*="_previewBadge"] { display: none !important; }
`;

export interface Curation { workspaceName: string; headline: string }

/** Rename what can be renamed in the current DOM; safe to call repeatedly (it only writes when something differs). */
export function applyText(doc: Document, { workspaceName, headline }: Curation): void {
  for (const el of doc.querySelectorAll('[class*="_localBuildTitle"], [class*="_fallbackBrandName"]')) {
    if (el.textContent !== workspaceName) el.textContent = workspaceName;
  }
  for (const title of doc.querySelectorAll('[class*="_titleGroup"] > span:first-child')) {
    if (title.textContent === DEFAULT_HEADLINE) title.textContent = headline;
  }
}

/** Install the style and keep the text edits applied while the harness re-renders. Idempotent per document. */
export function curate(doc: Document, options: Curation): void {
  if (!doc.head || !doc.body || doc.getElementById('gw-curation')) return;
  const style = doc.createElement('style');
  style.id = 'gw-curation';
  style.textContent = STYLE;
  doc.head.append(style);
  const run = () => applyText(doc, options);
  run();
  new MutationObserver(run).observe(doc.body, { childList: true, subtree: true });
}
