/** Page data the gateway embeds in `<script id="gw-boot">`; mirrors the page functions in ../../src/pages.js. */
export type Boot =
  | { page: 'login'; error?: string; allowSignup: boolean }
  | { page: 'feedback'; email: string; context: Record<string, string>; kinds: string[]; sent?: boolean; error?: string }
  | { page: 'launching'; stages: string[] }
  | { page: 'shell'; email: string; src: string };

export function readBoot(): Boot {
  const el = document.getElementById('gw-boot');
  return JSON.parse(el?.textContent ?? '{}') as Boot;
}
