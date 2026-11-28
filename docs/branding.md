# Branding: the service's own icon

Written 2026-11-27. What was checked is marked; what was not is said.

## Why

The harness is MIT licensed ([the harness's LICENSE](../../deepseek-harness/LICENSE)), so changing its icons is allowed. Its [BRAND_GUIDELINES.md](../../deepseek-harness/BRAND_GUIDELINES.md) is separate: "DeepSeek Harness" is a registered trademark of DeepSeek, a derived project should not use the full name as its own name (this one is `dsh-cloud`), and official brand materials should not be used in a way that suggests endorsement. This service is not the official build, so it shows its own mark. This is a reading of the files, not legal advice; nothing outside the checkout (DeepSeek's site terms) was read.

The mark is the icon of the owner's Framewrite (vid2doc) project, `../vid2doc/marketing/public/images/framewrite_icon.png` (800 x 800). **Not used: the Framewrite logo file**, because it contains the name "FRAMEWRITE" and the tagline "Turn any video into a written record", which describe another product. The name `dsh-cloud` is live text next to the icon. Whether the artwork contains third-party elements was not checked.

## What changed (verified in a real browser, 2026-11-27)

| Surface | Now |
| --- | --- |
| Sign-in, sign-up and every standalone gateway page | icon and the text `dsh-cloud` (`gateway/web/src/BrandWordmark.tsx`) |
| Signed-in top bar and admin | same component |
| Browser tab (title and icon) | title `dsh-cloud`, icon `favicon-32.png`, `apple-touch-icon.png`; set in `gateway/web/index.html` and `gateway/src/pages.js`. **The workspace is an iframe inside the gateway's page, so the tab shows the gateway's title and icon, not the harness's own favicon files**; those are never shown and are not replaced. |
| Workspace sidebar header and the home-page hero (the whale) | the plugin `sandbox/brand` (below) |
| Home-page pixel-whale animation and the official sidebar artwork | switched off: the patch row `ui-brand-official` is `disabled: true` in `sandbox/entrypoint.sh` (confirmed with `dsh --profile web --patch ... --dump-config`) |

## The plugin: how the whale was replaced without editing the harness

Switching the official brand plugin off is not enough: the sidebar and the home hero then fall back to `FishLogo`, **the same whale artwork**, compiled into the client (`ui-primitives/src/FishLogo.tsx`; checked in the browser). So a plugin takes those two seats.

- **Where it lives:** `sandbox/brand/` in this repository, copied to `/opt/dsh-brand` in the image. Nothing in `../deepseek-harness` is changed (that checkout has uncommitted work of its own; none of it was touched).
- **How the harness finds it (read in `docs/subsystems/client-modules.md`, then confirmed):** the host scans its loaded plugins for packages that declare `dsh.client` in `package.json`, serves each one's `lib/client.js` to the page, and lists it in the page's boot graph. A client half is a plain script in a fixed shape (`window.__ModuleLoader__.load({ id, factory })`, the same shape the harness's own client bundles have), so `sandbox/brand/client.template.js` is **hand-written, with no build step**, and uses the shell's own React.
- **What it does:** registers a component for `sidebar.brand.mark` and `conversation.hero.brand.mark` that draws the icon as an `<img>` (a data URI inside the script) at the size the shell asks for. It leaves `sidebar.brand.name` alone: the shell's own text fallback ("Workspace") stays.
- **Regenerating:** `scripts/render-branding.sh` renders the icon sizes and writes `sandbox/brand/lib/client.js` from the template with the icon embedded. Edit the template, not the generated file.
- **Two mistakes found on the way:** a patch row with an unknown `id` is refused ("entry not found"), so a new plugin is added with `- insert:`; and a row naming the package's directory fails at start-up with `ERR_UNSUPPORTED_DIR_IMPORT` ("1 entry did not activate", only a warning in the log), so the row names the file, `/opt/dsh-brand/lib/index.js`. The live test fails on the directory form.
- **Fragile points:** the slot names and the shape of the client script are the harness's internal contract and can change in an upgrade (the same caveat as the other patch rows in the entrypoint); the live test fails if the plugin stops loading or being served. A harness whose slots were renamed would load the plugin yet show the whale again, which only a browser check would show.

## Still the DeepSeek whale (not replaced)

- The animated whale beside the "running" status while the agent works (`RunningWhaleTail` in `ui-chat`). It is drawn inside the chat code, not in a slot, so a plugin cannot take its place. Replacing it would mean a harness change or a stylesheet override of its hashed class names.
- Other whale artwork that may exist in settings or about dialogs was **not** looked for beyond a search of the client source for the whale components (`FishLogo`, `BrandWordmark`, `RunningWhaleTail`, `PixelWhale`; the first two are only used in the sidebar fallback, the viewer page of LiveShare, and the official plugin).

## Regenerating the icons

`scripts/render-branding.sh [SOURCE.png]` writes `brand-icon.png` (128 px), `favicon-32.png` and `apple-touch-icon.png` (180 px) into `gateway/web/public/`, and `sandbox/brand/lib/client.js`, from a square source of at least 512 px. It needs macOS `sips`; elsewhere render the three sizes with any tool. Then `cd gateway/web && npm run build`, and rebuild the sandbox image for the plugin. The icons are served at `/gw/assets/<name>` with a one-hour cache (their names are not hashed, unlike the build output, which is cached for a year).

## Tests

`tests/gateway/branding.test.mjs` (no Docker; needs the pages built): the three PNGs are served publicly with the right type and a short cache while the built script keeps its long one, unknown names and traversal get 404; the pages have the title and icon links and no DeepSeek name; no `.ts`, `.tsx` or `.html` file under `gateway/web/src` names DeepSeek, mentions a whale or contains vector artwork (CSS colour-token names such as `--dsw-static-deepseek-500` are not branding and are not scanned); the entrypoint patch disables `ui-brand-official`. The plugin has its own tests: `tests/sandbox/brand.test.mjs` (manifest, the embedded icon equals the rendered one, behaviour against a fake loader and slot registry), `tests/sandbox/entrypoint.test.mjs` (the two rows) and `tests/phase6/branding.test.mjs` (the real harness in the real image loads and serves it). Checked to fail: the old wordmark component, a renamed patch row, a wrong slot name, a stale icon, and the directory form of the row (live test) each make a test fail.

## Not verified

- The Framewrite artwork's own licence or third-party content (it is the owner's project; assumed).
- That the dark theme looks right: the icon is a dark tile and was only viewed on the light theme.
- The plugin in other browsers (checked in Chromium only), and in the desktop app (not served by this stack).
- Phase 2 to 4 Docker suites were not run for this change (they delete data and need approval). `tests/ui/welcome.test.mjs` now looks for the iframe titled `Workspace` instead of `DeepSeek Harness`; it passes (4 tests, in a real browser). `tests/run.sh unit` passes (339).
