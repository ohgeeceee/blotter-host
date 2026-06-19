# Production Settings Design

## Scope

Add a first production-readiness settings layer to the private `blotter-host` app. The settings should help bring `blotter.host`, `admin.blotter.host`, and all state subdomains toward production without introducing a heavy framework or external control plane.

## Goals

- Store editable platform settings in a local JSON file.
- Expose settings and readiness status through authenticated admin API endpoints.
- Show production settings, readiness checks, and state launch status in the admin panel.
- Keep the implementation dependency-free and compatible with the existing CommonJS app.
- Avoid GitHub, commits, or public publishing.

## Data Model

Settings live at `/root/blotter-host/data/settings.json`.

Main groups:

- `network`: platform name, root domain, admin host, launch mode, support email, public disclaimer.
- `admin`: session hours and panel notes.
- `production`: DNS provider, TLS mode, database mode, scraper controller mode.
- `states`: optional per-state launch overrides keyed by tenant slug.

Defaults are supplied in code so the app works even when `settings.json` does not exist.

## API

Authenticated admin routes:

- `GET /admin/api/settings`: returns settings plus readiness checks.
- `POST /admin/api/settings`: saves edited network/admin/production settings.

## Admin UI

Add a "Production settings" panel above the tenants table. It shows:

- Network fields.
- Production mode selectors.
- Readiness checklist.
- State launch summary.

## Readiness Checks

Checks are local and conservative:

- Admin secrets configured.
- `settings.json` writable.
- Service environment detected.
- PostgreSQL configuration detected.
- SQL migration file present.
- `tenants.json` has registered tenants.
- Nginx config exists.
- TLS mode setting is not self-signed for production.

## Non-Goals

- No PostgreSQL-backed settings in this pass.
- No normalized incident or booking tables.
- No external DNS API changes.
- No GitHub or repository publishing.
