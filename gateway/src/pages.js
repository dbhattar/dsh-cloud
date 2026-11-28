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
export function appShellPage({ email, src, workspaceName = 'Workspace' }) {
  return render('dsh-cloud', { page: 'shell', email, src, workspaceName });
}

/**
 * Sign-in and sign-up page. `invite` is `{ code, status }` when the page was opened from an invite link or a sign-up failed on
 * the code; `next` is a vetted path to return to after signing in; `email` refills the form after a failure; `mode` picks which
 * form leads ('signup' for an invite link).
 */
export function loginPage({ error, notice, canReset = false, canJoinWaitlist = false, allowSignup, inviteRequired = false, invite = null, next = null, email = null, mode = 'login' }) {
  return render('Sign in', { page: 'login', error, notice, canReset: !!canReset, canJoinWaitlist: !!canJoinWaitlist, allowSignup: !!allowSignup, inviteRequired: !!inviteRequired, invite, next, email, mode });
}

/** Ask for a reset link (/gw/forgot). `available` is false when no mail is set up; `sent` is the one answer to every request. */
export function forgotPage({ available = true, sent = false, error, email = null }) {
  return render('Reset your password', { page: 'forgot', available: !!available, sent: !!sent, error, email });
}

/** Ask for a place (/gw/waitlist). `done` is the one answer to every request; `confirmMail` says a confirmation message was promised. */
export function waitlistPage({ done = false, confirmMail = false, error, email = null }) {
  return render('Join the waitlist', { page: 'waitlist', done: !!done, confirmMail: !!confirmMail, error, email });
}

/** Choose a new password (/gw/reset?token=). `status` is the token's state; the form shows only for 'valid'. */
export function resetPage({ token, status, error }) {
  return render('Choose a new password', { page: 'reset', token: status === 'valid' ? token : '', status, error });
}

/** A short message with at most one button: `action` is { label, href, fields } posted as a form. */
export function noticePage({ title, message, action = null }) {
  return render(title, { page: 'notice', title, message, action });
}

/** The admin panel (/gw/admin), served only to admins; see admin.js. */
export function adminPage({ email, csrf = '' }) {
  return render('Admin', { page: 'admin', email, csrf });
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
