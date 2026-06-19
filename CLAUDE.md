# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`blotter-host` is a Node/Express multi-tenant router that serves:

- The apex `blotter.host` — control room, admin panel, and a network landing page
- Every `<state>.blotter.host` subdomain — a state-specific public blotter site
- `admin.blotter.host` — same control surface, locked behind bcrypt + HMAC cookie auth

All HTML is rendered server-side by a hand-rolled template engine (no JSX, no React, no view framework).

## Commands

```bash
npm start                  # production: node server.js (binds 127.0.0.1:3000)
npm run dev                # node --watch server.js (auto-restart on edit)

# Tests use the built-in node:test runner — there is no "test" script in package.json.
node --test test/                                          # all tests
node --test test/subdomain.test.js                         # one file
node --test test/name.test.js -t "pattern matching test"   # one test by name

# Lint/format: NONE configured. The project follows the style already in the file
# (CommonJS, 'use strict', 2-space indent, single quotes, trailing commas).
```

The control SQLite DB is auto-created on first start at `data/control.db` — no manual migration step.

## Source-of-truth files

| Concern | File | Notes |
|---|---|---|
| Tenant registry | `tenants.json` (root) | mtime-cached by `src/data/state-registry.js`. Add a state by adding one object — no code change. |
| Control DB schema | inline in `src/db.js` | `scraper_status`, `scraper_runs`, `scraper_logs`. WAL mode. |
| Production settings | `data/settings.json` | Read/written by `src/control/settings.js`. |
| Postgres schema | `sql/*.sql` | RLS policies live here, not in code. |
| Nginx vhost | `deploy/nginx-blotter-host.conf` | Wildcard `*.blotter.host` → `127.0.0.1:3000`; ACME http-01 at `/.well-known/acme-challenge/`. |
| systemd unit | `deploy/blotter-host.service` | Current install runs as root from `/root/blotter-host`. |

## Request lifecycle

1. **`src/middleware/subdomain.js`** parses `Host` and sets one of:
   - `req.isRootAdmin = true` → apex or `admin.*`
   - `req.tenant` (frozen registry entry) + `req.stateContext` (2-letter code) → known state subdomain
   - 421 for hosts outside the network, 404 for unknown `*.blotter.host` children
2. `server.js` branches on those flags and dispatches to one of three router families.
3. Tenant queries go through `src/db/pg.js` which sets the Postgres GUC `app.current_state_id` to scope RLS to the current state. Cross-state queries use the `'*'` sentinel and `db.adminQuery()`.

## Three surfaces, two data planes

**Surfaces (routers):**
- `src/routes/admin.js` — `/admin/*` (apex only, HMAC cookie). Mounts `src/control/api.js` at `/admin/api/*`.
- `src/routes/dashboard.js` — apex control room (network health, scraper fleet).
- `src/routes/root.js` — apex landing page + `/api/states` + `/api/cross-state-search` (not yet mounted — see "Drift" below).
- `src/routes/state-public.js` — active pipeline-based tenant surface.

**Data planes:**
- **SQLite (`data/control.db`)** — operator-facing: scraper status, run history, log tail, settings. Used only by the control/admin surfaces.
- **PostgreSQL** — public-facing: `blotters`, `blotter_persons`, etc. All tenant and cross-state search queries go here. RLS policies are assumed by `src/db/pg.js` (see header comment in that file for the expected policy).

`src/db/pg.js` is lazy and degrades gracefully: if `DATABASE_URL` is unset, query helpers return `{ ok: false, error }` instead of throwing, and routes return 503.

## Template engine (`src/render/template.js`)

No dependencies. Three token forms:

- `{{KEY}}` — HTML-escaped value from context
- `{{{KEY}}}` — raw (use only for values you built yourself; triple-brace is required for pre-escaped HTML strings like `BLOTTER_LIST_HTML`)
- `{{> partials/path}}` — inlines another template file; `.html` is auto-appended; recursion is supported
- `{{#if KEY}}…{{/if}}` — conditional; falsy = `'' / 0 / null / undefined / false`. **Not nested.** Critically, `{{#if}}` is only evaluated on the *top-level* template — it does NOT fire inside partials. Render nested conditionals by branching in the route handler and choosing the partial, or by pre-rendering HTML and passing it via `{{{...}}}`.

mtime-aware in-memory cache; editing a `views/` file in dev is visible on the next request.

`src/render/pipeline.js` (`renderForState(tenant, viewName, ctx)`) is the higher-level entry point that fills in `{{STATE_NAME}}`, `{{ACCENT_COLOR}}`, `{{CANONICAL_HOST}}`, `{{BAIL_BOND_HTML}}`, etc. using tenant overrides from `tenants.json` with network-wide defaults. **Use this rather than calling `render()` directly from a route.**

## State registry invariants

`src/data/state-registry.js` validates every entry in `tenants.json` and silently skips bad ones (logging to stderr). The validators it enforces:

- `slug` must match `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`
- `code` must be a 2-letter US state code (postal). Set it explicitly — postal codes don't always match `slug.toUpperCase().slice(0,2)` (e.g. `DC`, `NH`, `RI`).
- Reserved slugs are blocked: `www, api, cdn, mail, admin, static, auth, sso`.
- Slug and code are both unique across the registry.

The registry reloads only when `tenants.json`'s mtime changes. Adding a state is: edit JSON + restart (no SIGHUP handler yet).

## Control / admin auth model

- `src/middleware/adminAuth.js` issues an HMAC-signed cookie (`blotter_admin`) with `{ sub, exp }` claims. 8-hour TTL. `HttpOnly`, `SameSite=Strict`, `Secure` in production.
- Password verification is `bcrypt.compare` against `ADMIN_PASSWORD_HASH` (env var).
- Mounted at `/admin` only when `isAdminHost(req)` is true (apex or `admin.blotter.host`).
- The `/admin/api/*` namespace requires `X-Requested-With: XMLHttpRequest` on POST routes (CSRF defense — the cookie isn't auto-attached by browsers on cross-origin form posts).

## Drift to know about

This is concurrent work — multiple agents edit this tree. Current drift as of this writing:

- **`src/routes/state-public.js` is the source of truth for `<state>.blotter.host`.**
- **`src/routes/root.js` (apex landing + cross-state search) is mounted for apex non-admin traffic.** Keep the cross-state search PII gate in place unless the auditor says otherwise.
- **Cross-state search** (`/api/cross-state-search`) is implemented but per the file's own header comment, should remain gated behind `requireAdmin` until the PII auditor (`/root/montanablotter/blotter_auditor.py`) gives the all-clear for cross-state name search.
- `src/lib/load-env.js` is a dependency-free `.env` loader (does NOT override already-set `process.env` values).

## How to add a state

1. Append an object to `tenants.json` with `slug`, `code`, `name`, and a `public` sub-object.
2. Restart the app (or wait for SIGHUP support, which doesn't exist yet).

## News sources

Operators can add per-state RSS feeds and news-station homepages through the
admin panel at `/admin/news-sources`. Sources are stored in the SQLite control
DB (`news_sources` table) and scraped on the same 3-hour cron cycle as the
hardcoded sources.

- `source_type`: `rss` (parsed by `rssBulletin`) or `website` (scraped by
  `staticBulletin` / `dynamicBulletin`).
- `strategy`: must match `source_type` (`rssBulletin` for RSS,
  `staticBulletin`/`dynamicBulletin` for websites).
- `is_enabled`: disabled sources are skipped by the scheduler.
- `metadata_json`: optional per-source tuning such as `{"max_entries": 10}`.

API endpoints (all under `/admin/api`, POST routes require
`X-Requested-With: XMLHttpRequest`):

- `GET /news-sources?state=<slug>`
- `POST /news-sources`
- `GET /news-sources/:id`
- `PUT /news-sources/:id`
- `DELETE /news-sources/:id`
- `POST /news-sources/:id/test` — fetch the URL and report reachability / RSS-ness
- `POST /news-sources/run` — manually run all enabled news sources (optionally
  `{"state_slug": "idaho"}`)

An autonomous discovery agent lives in
`scripts/news-source-discovery/discover.py`. It searches Wikipedia's
"List of newspapers in <State>", validates RSS feeds, and can write proposed
sources to the control DB as disabled entries for review. See
`scripts/news-source-discovery/README.md`.
3. If the state has its own scraper, set `scraperCommand` and `scraperCwd` on the tenant entry. `src/control/runner.js` parses and spawns the command; the runner respects `scraper_status.paused` and won't double-start.
4. If the state needs its own Postgres data, set up the `state_code` partition and the `blotters` row before pointing the scraper at it.
