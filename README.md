# CallScope reporting

Call-centre reporting dashboard for the Birns PBX: PHP endpoints under `api/`,
a single-page React front end (`assets/js/app.js` + `assets/css/app.css`), and a
JSON cache of PBX CDRs under `cache/`.

```
index.php            → redirects into the app shell (portal.php)
portal.php           → the HTML shell that boots assets/js/app.js
api/*.php            → one endpoint per view (session + role gated, JSON in/out)
includes/            → shared code: bootstrap, auth, security, export, PBX client, config
includes/reporting/  → the reporting layer as modules, loaded by includes/reporting.php
assets/js/app.js     → BUILT bundle (generated — never edit by hand)
assets/js/src/       → bundle source (this is what you edit)
assets/css/app.css   → BUILT stylesheet (generated — never edit by hand)
assets/css/src/      → stylesheet source (Tailwind entry + hand-written CSS)
cache/, logs/        → runtime state, never committed
tests/, tools/       → development harness (not deployed)
```

## Deploying

The deployed application is plain PHP + static files: copy `*.php`, `api/`,
`includes/` **including `includes/reporting/`**, `assets/`, and `CHANGES.md` to
the web root. There is no build step
on the server and no database to migrate — the front end is the committed bundle.

Configuration comes from the environment (`PBX_SERVERS`, `PBX_CLIENT_ID`,
`PBX_CLIENT_SECRET`, `PBX_SIP_TOKEN`, …) or from `includes/config.local.php`,
which stays on the server (it is git-ignored).

## Development

`package.json` exists **only** for the development toolchain; it is not needed in
production.

```
npm install          # esbuild, Tailwind CLI, jsdom, acorn, php-parser, php-wasm
npm test             # everything: php lint, css coverage, build, js smoke, api matrix
npm run build        # regenerate assets/js/app.js and assets/css/app.css from src/
npm run build:js     # JS only
npm run build:css    # CSS only
npm run lint:php     # syntax + banned-construct scan over every .php file
```

* **Edit the sources under `assets/js/src/` and `assets/css/src/`, never the
  built files.** `npm run build` rewrites both bundles; the build is
  deterministic (identical sources → byte-identical output), so a rebuild that
  produces no diff means the committed bundle really does match the source.
  `assets/js/src/app.js` is the entry point (React root + `App`); everything
  else lives in `lib/` (api, time, format, sla, recording, react helpers,
  theme) and `components/` (one file per screen or dialog). The table of
  contents is `tools/app-modules.json` and `tools/module-budget.mjs` fails the
  build if a module grows past 2,000 lines or is imported by nobody.
* `tools/css-coverage.mjs` fails the build if any Tailwind utility or custom
  class used in the sources is missing from the built stylesheet — the check
  that keeps a Tailwind class from silently disappearing.
* `tools/ui-audit.mjs` (`npm test` runs it with `--strict`) checks the UI
  consistency rules that a compiler cannot: every clickable element must say
  how it behaves (`cursor-pointer` / `cursor-default`), keyboard-reachable,
  and explained by a `title`; colours in JS must use the theme tokens; loading
  states must render the shared `skel()` placeholder; heavy third-party code
  must be loaded on demand. Run it on its own for the full report.
* `tests/js/` runs the real bundle in jsdom with React and Chart stubs;
  `tests/php/` executes every `api/*.php` under real PHP 8.4 (php-wasm) and
  asserts the session/method/role gates and the response contract.
