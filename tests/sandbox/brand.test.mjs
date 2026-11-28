// The dsh-cloud-brand harness plugin (sandbox/brand): well-formed, in step with its source icon, and doing what it should when the
// harness runs it. The harness is not needed: the browser half is run here against a fake module loader and slot registry. No Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p));
const pkg = JSON.parse(read('sandbox/brand/package.json'));

test('the package declares a web client half the host can find, and a node half', () => {
  assert.equal(pkg.name, 'dsh-cloud-brand');
  assert.deepEqual(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.equal(pkg.main, 'lib/index.js');
  assert.match(read('sandbox/brand/lib/index.js').toString(), /export function apply\(\)/);
  // it must wait for the packages that declare the slots it fills
  for (const dep of ['ui-renderer', 'ui-sidebar', 'ui-conversation']) assert.ok(pkg.dsh.client.inject.includes(`@deepseek-ai/dsh-client-${dep}`), dep);
});

test('lib/client.js is the template with the current icon in it, nothing left to fill', () => {
  const js = read('sandbox/brand/lib/client.js').toString();
  const icon = read('gateway/web/public/brand-icon.png').toString('base64');
  assert.ok(js.includes(`data:image/png;base64,${icon}`), 'the embedded icon is gateway/web/public/brand-icon.png (run scripts/render-branding.sh)');
  assert.ok(!js.includes('__ICON_DATA_URI__'));
  assert.ok(read('sandbox/brand/client.template.js').toString().includes('__ICON_DATA_URI__'));
});

/** Run the browser half the way the harness page does and return what it registered. */
function run() {
  let loaded;
  const sandbox = { window: { __ModuleLoader__: { load: (m) => { loaded = m; } } } };
  vm.runInNewContext(read('sandbox/brand/lib/client.js').toString(), sandbox);
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) };
  const mod = loaded.factory((id) => { assert.equal(id, 'react'); return React; });
  const registered = [];
  const ctx = { slots: { inject: (name, fn) => { injected.push(name); const out = fn(); if (out?.next) for (const r of out) registered.push(r); return out; }, register: (opts, component) => ({ opts, component }) } };
  const injected = [];
  mod.apply(ctx);
  return { loaded, mod, registered, injected };
}

test('it asks for the slot registry, waits for both slots, and fills exactly the two mark seats', () => {
  const { loaded, mod, registered, injected } = run();
  assert.equal(loaded.id, 'dsh-cloud-brand');
  assert.deepEqual([...mod.inject], ['slots']); // spread: the array comes from another realm (vm)
  assert.deepEqual(injected, ['sidebar.brand.mark', 'conversation.hero.brand.mark']);
  assert.deepEqual(registered.map((r) => r.opts.name).sort(), ['conversation.hero.brand.mark', 'sidebar.brand.mark']);
  assert.ok(registered.every((r) => r.opts.priority === undefined), 'no rank tricks: the official plugin is switched off instead of shadowed');
});

test('the mark renders the icon at the size the shell asks for, with no text and no DeepSeek artwork', () => {
  const { registered } = run();
  const el = registered[0].component({ size: 24, className: 'x' });
  assert.equal(el.type, 'img');
  assert.equal(el.props.width, 24);
  assert.equal(el.props.height, 24);
  assert.equal(el.props.alt, '');
  assert.match(el.props.src, /^data:image\/png;base64,/);
  assert.equal(registered[1].component({ size: 56 }).props.width, 56);
  assert.doesNotMatch(read('sandbox/brand/lib/client.js').toString().replace(/base64,[A-Za-z0-9+/=]+/, ''), /deepseek|whale|fish/i);
});

test('the image build ships the package where the entrypoint row points', () => {
  assert.match(read('sandbox/Dockerfile').toString(), /^COPY brand\/ \/opt\/dsh-brand\/$/m);
});
