// The brand plugin (docs/branding.md): the REAL harness in the REAL image, started the way a sandbox starts it, loads dsh-cloud-brand
// and serves its browser half to the page. Self-contained and non-destructive: one throwaway container, no volumes, no compose stack.
// Needs the image (`docker build -t dsh-sandbox:latest sandbox`). Runs under runc or gVisor alike (no confinement is involved).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from '../lib/helpers.mjs';
import { IMAGE, docker, requireImage, tryDocker } from '../lib/sandbox-box.mjs';

const NAME = 'dsh-brand-probe';
let page = '';
let logs = '';

/** GET a path from the harness inside the container; it answers only with its auth cookie, which the launch token buys. */
let token = '';
const get = (path) => docker('exec', NAME, 'sh', '-c',
  `IP=$(hostname -i | cut -d' ' -f1); C=$(curl -s -i -m 10 "http://$IP:3080/?token=${token}" | sed -n 's/^set-cookie: \\([^;]*\\);.*/\\1/Ip' | head -1); curl -s -m 10 -H "cookie: $C" "http://$IP:3080/${path}"`);

before(async () => {
  requireImage();
  tryDocker('rm', '-f', NAME);
  docker('run', '-d', '--name', NAME, '-e', 'DSH_PUBLIC_URL=https://localhost/', '-e', 'DSH_TRUSTED_HOST=localhost', IMAGE);
  token = await waitFor(() => /[?&]token=([\w-]+)/.exec(tryDocker('logs', NAME) + '')?.[1], { what: 'the harness to print its launch token', timeoutMs: 90000 });
  page = get('');
  logs = tryDocker('logs', NAME); // after the page is served: a row that fails to load is reported after the launch token
});
after(() => { tryDocker('rm', '-f', NAME); });

test('the harness starts with the brand plugin row and no entry fails to activate', () => {
  assert.ok(!/did not activate/.test(logs), `a plugin row failed to load:\n${logs.slice(-800)}`);
  assert.ok(!/dsh-cloud-brand[^\n]*failed/.test(logs), logs.slice(-800));
});

test('the page boot graph lists dsh-cloud-brand and not the official brand plugin', () => {
  assert.ok(page.length > 10000, 'the harness page was served');
  assert.match(page, /dsh-cloud-brand\/client\.js/);
  assert.doesNotMatch(page, /dsh-client-ui-brand-official\/client\.js/, 'the official whale plugin must not be served');
});

test('the served browser half carries the icon and fills the two mark seats', () => {
  const url = /"(plugins\/\?\?dsh-cloud-brand\/client\.js&rev=[0-9a-f]+)"/.exec(page)?.[1];
  assert.ok(url, 'found the plugin\'s own script entry in the boot graph');
  const js = get(url);
  assert.match(js, /dsh-cloud-brand/);
  assert.match(js, /data:image\/png;base64,iVBOR/);
  assert.match(js, /sidebar\.brand\.mark/);
  assert.match(js, /conversation\.hero\.brand\.mark/);
});
