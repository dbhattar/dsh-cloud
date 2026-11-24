import { readFileSync } from 'node:fs';
import { STAGES } from './sandbox.js';

// Pages are a React app (web/, built by `npm run build` there) styled with the deepseek-harness
// design tokens. The server only picks the page and embeds its data; the app renders it.
export const WEB_DIST = new URL('../web/dist/', import.meta.url);

let template;
function loadTemplate() {
  if (template) return template;
  try {
    template = readFileSync(new URL('index.html', WEB_DIST), 'utf8');
  } catch (e) {
    throw new Error(`gateway pages are not built (${e.code}); run "npm ci && npm run build" in gateway/web`);
  }
  return template;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// JSON inside <script>: '<' must not be able to close the element or open a comment.
const embed = (data) =>
  JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);

function render(title, data) {
  return loadTemplate()
    .replace('<!--gw:title-->', () => esc(title))
    .replace('<!--gw:boot-->', () => `<script id="gw-boot" type="application/json">${embed(data)}</script>`);
}

/** Authenticated top-level page: account bar + the harness UI in a same-origin iframe. */
export function appShellPage({ email, src }) {
  return render('DeepSeek Harness', { page: 'shell', email, src });
}

export function loginPage({ error, allowSignup, inviteRequired = false }) {
  return render('Sign in', { page: 'login', error, allowSignup: !!allowSignup, inviteRequired: !!inviteRequired });
}

export const FEEDBACK_KINDS = ['bug', 'idea', 'other'];

/** Feedback form opened from the harness menu; the harness passes context as prefill_* query params. */
export function feedbackPage({ email, context = {}, sent = false, error }) {
  return render('Feedback', { page: 'feedback', email, context, kinds: FEEDBACK_KINDS, sent, error });
}

/** Shown (inside the app iframe) while the user's sandbox starts; polls /gw/api/status client-side. */
export function launchingPage() {
  return render('Starting your workspace', { page: 'launching', stages: STAGES.map((s) => s.label) });
}
