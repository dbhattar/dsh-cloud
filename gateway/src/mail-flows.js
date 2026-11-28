import { createHmac, timingSafeEqual } from 'node:crypto';
import { RateLimiter } from './auth.js';
import { inviteEmail, passwordChangedEmail, resetEmail, taskFinishedEmail, testEmail, waitlistConfirmEmail } from './mail-templates.js';

/**
 * What the gateway mails and when (docs/email.md). Each function decides whether to send and what to say; the mailer in mail.js
 * delivers. Nothing here throws into the caller: a message that cannot go out is reported in the return value and the audit trail.
 */
export function createMailFlows({ cfg, store, mailer, audit, now = Date.now }) {
  const base = (path) => new URL(path, cfg.publicUrl).href;
  const noticeLimiter = new RateLimiter(1, cfg.mail.taskNoticeHours * 3600_000, now); // one task notice per user per window

  /** The opt-out link carries a signature of the user id, so it needs no stored token and cannot be forged for another user. */
  const sign = (what) => createHmac('sha256', cfg.runnerSecret).update(what).digest('base64url');
  const sameSig = (want, got) => {
    const a = Buffer.from(want);
    const b = Buffer.from(String(got ?? ''));
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const stopSig = (userId) => sign(`mail-stop:${userId}`);
  const stopLink = (userId) => base(`gw/mail/stop?u=${userId}&t=${stopSig(userId)}`);
  const checkStopSig = (userId, sig) => sameSig(stopSig(userId), sig);
  const waitSig = (email) => sign(`waitlist-confirm:${email}`);

  return {
    /** Whether messages really leave the gateway (false with MAIL_PROVIDER=log). */
    get enabled() { return mailer.enabled; },
    stopSigOk: checkStopSig,
    waitlistSigOk: (email, sig) => sameSig(waitSig(email), sig),

    /** Ask a new waitlist entry to confirm its address (the link is signed, so it needs no stored token). */
    waitlistConfirm(email) {
      return mailer.send({ kind: 'waitlist_confirm', to: email, ...waitlistConfirmEmail({ link: `${base('gw/waitlist/confirm')}?e=${encodeURIComponent(email)}&t=${waitSig(email)}` }) });
    },

    /** A reset link for the account, if it exists and may sign in. Same answer to the caller either way (see server.js). */
    requestReset(email) {
      const user = store.userByEmail(email);
      if (!user || user.suspended_at) return { sent: false, known: Boolean(user) };
      const token = store.createResetToken(user.id, cfg.mail.resetMinutes * 60_000, now());
      const msg = resetEmail({ link: base(`gw/reset?token=${token}`), minutes: cfg.mail.resetMinutes });
      return { ...mailer.send({ kind: 'reset', to: user.email, userId: user.id, ...msg }), known: true, userId: user.id };
    },

    passwordChanged(userId) {
      const user = store.userById(userId);
      if (!user) return { queued: false };
      return mailer.send({ kind: 'password_changed', to: user.email, userId, ...passwordChangedEmail({ loginUrl: base('gw/forgot') }) });
    },

    /** Mail an invite code as a sign-up link. The caller made the invite; the link goes in the message and nowhere else. */
    invite({ email, code, days = 0, userId = null }) {
      return mailer.send({ kind: 'invite', to: email, userId, ...inviteEmail({ link: `${base('gw/signup')}?invite=${encodeURIComponent(code)}`, days }) });
    },

    /** The agent kept working after the user left and has now stopped: tell them, at most once per window, unless they opted out. */
    taskFinished(userId) {
      if (!cfg.mail.taskNotices || !mailer.enabled) return { queued: false, reason: 'off' };
      const user = store.userById(userId);
      if (!user || user.suspended_at || !store.mailNotices(userId)) return { queued: false, reason: 'opted_out' };
      const key = String(userId);
      if (noticeLimiter.blocked(key)) return { queued: false, reason: 'too_soon' };
      noticeLimiter.fail(key);
      return mailer.send({ kind: 'task_finished', to: user.email, userId, ...taskFinishedEmail({ openUrl: base(''), stopUrl: stopLink(userId) }) });
    },

    /** For the command line: one message to an address, to see that the provider settings work. */
    test(to) {
      return mailer.send({ kind: 'test', to, ...testEmail() });
    },
  };
}
