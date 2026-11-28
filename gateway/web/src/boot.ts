/** Page data the gateway embeds in `<script id="gw-boot">`; mirrors the page functions in ../../src/pages.js. */
export type Boot =
  | { page: 'login'; error?: string; notice?: string; canReset?: boolean; canJoinWaitlist?: boolean; allowSignup: boolean; inviteRequired?: boolean; invite?: { code: string; status: 'valid' | 'used' | 'expired' | 'revoked' | 'unknown' } | null; next?: string | null; email?: string | null; mode?: 'login' | 'signup' }
  | { page: 'forgot'; available: boolean; sent: boolean; error?: string; email?: string | null }
  | { page: 'waitlist'; done: boolean; confirmMail: boolean; error?: string; email?: string | null }
  | { page: 'reset'; token: string; status: 'valid' | 'used' | 'expired' | 'unknown'; error?: string }
  | { page: 'notice'; title: string; message: string; action?: { label: string; href: string; fields: Record<string, string> } | null }
  | { page: 'feedback'; email: string; context: Record<string, string>; kinds: string[]; sent?: boolean; error?: string }
  | { page: 'launching'; stages: string[] }
  | { page: 'admin'; email: string; csrf: string }
  | { page: 'shell'; email: string; src: string; workspaceName?: string };

export function readBoot(): Boot {
  const el = document.getElementById('gw-boot');
  return JSON.parse(el?.textContent ?? '{}') as Boot;
}
