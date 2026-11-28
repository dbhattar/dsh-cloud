/**
 * The text of every message the gateway sends. Plain text only, short, and each says why the person got it. No tracking links:
 * the sender turns Mailgun's click and open tracking off, because a rewritten reset link is both unreliable and a leak.
 * Never put content from a workspace (prompts, files, model output) in a message.
 */
const SIGN_OFF = '\n--\ndsh-cloud';

export function resetEmail({ link, minutes }) {
  return {
    subject: 'Reset your dsh-cloud password',
    text: `Someone asked to reset the password for this email address.\n\nTo choose a new password, open this link within ${minutes} minutes. It works once:\n\n${link}\n\nIf this was not you, ignore this message: your password has not changed and nobody can use the link without this email.${SIGN_OFF}\n`,
  };
}

export function passwordChangedEmail({ loginUrl }) {
  return {
    subject: 'Your dsh-cloud password was changed',
    text: `The password for this account was just changed, and every signed-in session was ended.\n\nIf you did this, you can ignore this message. If you did not, reset your password now (${loginUrl}) and tell whoever runs this service.${SIGN_OFF}\n`,
  };
}

export function inviteEmail({ link, days }) {
  const expiry = days > 0 ? ` The invitation is valid for ${days} day${days === 1 ? '' : 's'}.` : '';
  return {
    subject: 'You are invited to dsh-cloud',
    text: `You have been invited to dsh-cloud, a hosted workspace for the DeepSeek Harness.\n\nOpen this link to create your account. It works once:\n\n${link}\n${expiry}\n\nIf you were not expecting this, you can ignore it.${SIGN_OFF}\n`,
  };
}

export function taskFinishedEmail({ openUrl, stopUrl }) {
  return {
    subject: 'Your dsh-cloud workspace finished working',
    text: `Your agent stopped working while you were away, and the workspace has paused. Your files and sessions are kept.\n\nOpen it again: ${openUrl}\n\nYou get at most one of these every few hours. To stop them: ${stopUrl}${SIGN_OFF}\n`,
  };
}

export function waitlistConfirmEmail({ link }) {
  return {
    subject: 'Confirm your place on the dsh-cloud waitlist',
    text: `Someone asked to put this email address on the waitlist for dsh-cloud, a hosted workspace for the DeepSeek Harness.\n\nTo stay on the list, confirm that the address is yours:\n\n${link}\n\nIf this was not you, ignore this message: nothing happens and you will not be contacted.${SIGN_OFF}\n`,
  };
}

export function testEmail() {
  return {
    subject: 'dsh-cloud mail test',
    text: `This is a test message from the dsh-cloud gateway. If you can read it, outgoing mail works.${SIGN_OFF}\n`,
  };
}
