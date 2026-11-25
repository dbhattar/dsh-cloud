// Optional real-browser support for the live suites. Zero dependencies in this repo: Playwright and a Chromium build
// are looked up on this machine (by default in the sibling deepseek-harness checkout and the Playwright cache), and
// every helper reports "not available" instead of failing, so suites still run their API checks without a browser.
// Override with PLAYWRIGHT_DIR (the playwright package directory) and CHROMIUM_PATH.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/helpers.mjs';

const playwrightDir = process.env.PLAYWRIGHT_DIR ?? join(ROOT, '..', 'deepseek-harness', 'apps', 'web', 'node_modules', 'playwright');

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright'); // macOS; on Linux ~/.cache/ms-playwright
  for (const dir of [cache, join(homedir(), '.cache', 'ms-playwright')]) {
    if (!existsSync(dir)) continue;
    for (const d of readdirSync(dir).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
      const mac = join(dir, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      const linux = join(dir, d, 'chrome-linux', 'chrome');
      for (const p of [mac, linux]) if (existsSync(p)) return p;
    }
  }
  return null;
}

/** { launch, available, why }: launch() resolves to a Playwright browser. */
export async function loadBrowser() {
  const exe = chromiumPath();
  if (!existsSync(join(playwrightDir, 'index.mjs')) || !exe) return { available: false, why: `Playwright (${playwrightDir}) or a Chromium build was not found` };
  const { chromium } = await import(pathToFileURL(join(playwrightDir, 'index.mjs')).href);
  return { available: true, launch: () => chromium.launch({ executablePath: exe }) };
}

/** Sign in as a user in a fresh browser context; returns the page. The base URL is https://localhost with a self-signed certificate. */
export async function signIn(browser, email, password, base = process.env.BASE_URL || 'https://localhost') {
  const page = await (await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(`${base}/gw/login`);
  await page.fill('form[action="/gw/login"] input[name=email]', email);
  await page.fill('form[action="/gw/login"] input[name=password]', password);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/gw/login'), { timeout: 30000 }), page.click('form[action="/gw/login"] button')]);
  return page;
}

/** All visible text of the page and its frames (the workspace is in an iframe). */
export async function allText(page) {
  const parts = await Promise.all(page.frames().map((f) => f.evaluate(() => document.body?.innerText ?? '').catch(() => '')));
  return parts.join('\n');
}

/** Poll until the page's text matches; returns the text, or throws with what was seen. */
export async function waitForText(page, pattern, { timeoutMs = 60000, everyMs = 1000 } = {}) {
  const end = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < end) {
    last = await allText(page);
    if (pattern.test(last)) return last;
    await page.waitForTimeout(everyMs);
  }
  throw new Error(`text ${pattern} never appeared; the page showed: ${last.replace(/\s+/g, ' ').slice(0, 300)}`);
}

/** Click a button by its accessible name in the page or any of its frames (the workspace and launching page are iframes). */
export async function clickButton(page, name, { timeoutMs = 30000 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const frame of page.frames()) {
      const button = frame.getByRole('button', { name });
      if (await button.count().catch(() => 0)) {
        await button.first().click();
        return;
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`no button named "${name}" appeared; the page showed: ${(await allText(page)).replace(/\s+/g, ' ').slice(0, 300)}`);
}
