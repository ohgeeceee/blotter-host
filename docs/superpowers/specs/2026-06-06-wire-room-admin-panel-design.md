# Wire Room Admin Panel Design

## Goal

Redesign the existing `blotter.host` admin panel into a simple, professional newsroom/editorial command center. The new surface should feel distinctive and purpose-built without adding backend scope or making routine scraper operations harder.

## Current State

The admin panel currently has three stacked sections:

- Production settings and readiness checks.
- Tenants table with scraper status and run/pause actions.
- Live logs with tenant and severity filters.

The existing data sources are sufficient for the redesign:

- `GET /admin/api/tenants`
- `GET /admin/api/settings`
- `POST /admin/api/settings`
- `POST /admin/api/tenants/:slug/scraper/run`
- `POST /admin/api/tenants/:slug/scraper/pause`
- `GET /admin/api/logs/stream`

## Design Direction

The approved direction is **Wire Room**: a three-zone editorial command surface.

The panel should read like a newsroom operations desk:

- Fast scan before detailed reading.
- Urgent states and stale scrapers are visually visible.
- Logs feel like a live wire feed.
- Settings are present but subordinate to operational work.
- The design is distinctive through layout, typography, labeling, and interaction language rather than heavy decoration.

## Layout

### Masthead Brief

The top of the page becomes a compact editorial masthead. It replaces the current generic “Control panel” header content inside the admin page.

It should include:

- Product/desk title such as `Wire Room`.
- Current generated time.
- Network counts derived from loaded tenant and settings data.
- Production posture summary: launch mode, TLS mode, database mode, controller mode.
- Compact readiness count: ready vs needs attention.
- Logout action.

The masthead must stay visually quiet and professional. It should not become a marketing hero.

### State Desk

The left rail is a state scan list built from the settings response `states` array.

Each row should show:

- State code.
- State or tenant name.
- Launch status.
- Whether public output is enabled.
- Whether a scraper command exists.

Rows needing attention should be easy to spot. The state list may be scrollable on desktop. On mobile it should become a horizontal or stacked section above the assignment board.

### Assignment Board

The center column is the primary working area. It replaces the current tenant table presentation while keeping the same actions and API calls.

Each tenant row should show:

- Tenant name and host.
- Scraper availability.
- Operational status: running, paused, idle, or missing command.
- Last heartbeat with relative time and exact timestamp on hover.
- Latest message when available.
- Actions: run now, pause, resume.

Rows should be dense enough for repeated use. The interaction model remains explicit buttons, not hidden gestures.

### Live Wire

The right rail is a persistent live feed from server-sent events.

It should include:

- Connection state.
- Tenant filter.
- Severity filter.
- Clear button.
- Log entries with timestamp, severity, tenant, and message.

The feed may use a dark editorial wire style, but it must remain readable and accessible. Error and warning states should use restrained color accents.

### Masthead Settings

Production settings remain editable, but they move into a compact section below or within the masthead area rather than leading the page.

The fields remain:

- Platform name.
- Support email.
- Launch mode.
- TLS mode.
- Database mode.
- Controller mode.
- Public disclaimer.

Save behavior remains unchanged.

## Interaction Behavior

- Loading tenants and settings should happen on page load as it does now.
- Tenant status should continue refreshing every 15 seconds.
- Running, pausing, and resuming scrapers should use the existing endpoints.
- The log stream should continue to use `EventSource`.
- Filters should apply client-side to the current feed.
- Saving settings should disable the save button while the request is in flight.
- Errors can continue using lightweight inline messages or alerts, but table/board loading failures should render in the affected section.

## Responsive Behavior

Desktop layout:

- Three-column command surface: State Desk, Assignment Board, Live Wire.
- Masthead spans the full width.
- Masthead Settings can sit below the command surface or as a compact full-width panel.

Tablet/mobile layout:

- Masthead first.
- State Desk becomes a compact stacked or horizontally scrollable scan section.
- Assignment Board follows.
- Live Wire follows.
- No content should require horizontal page scrolling, except for intentionally scrollable inner regions.

## Visual Style

The panel should avoid a generic SaaS card wall. It should use:

- Editorial labels such as `State Desk`, `Assignment Board`, `Live Wire`, and `Masthead`.
- Strong but restrained typographic hierarchy.
- Tabular numeric alignment for times and counts.
- Status markers that read like desk signals, not playful badges.
- A balanced palette with neutral paper/surface tones, dark ink, muted red/amber/green accents, and one link/action color.

Avoid:

- Decorative gradient backgrounds.
- Oversized hero sections.
- Nested card layouts.
- One-note blue/purple/dark dashboard styling.
- Hidden controls that slow down operations.

## Implementation Scope

Expected changed files:

- `views/admin/index.html`
- `public/css/admin.css`
- `public/js/admin.js`

Backend changes are out of scope. If implementation discovers missing data that cannot be derived from the existing settings, tenants, or log responses, pause and revise this spec before adding API work.

## Testing and Verification

Manual verification:

- Admin login still gates the page.
- `/admin/api/settings` still loads and saves.
- `/admin/api/tenants` still renders tenant operations.
- Run, pause, and resume buttons still hit the existing endpoints.
- Live logs still connect and filter.
- Layout works at desktop and mobile widths.

Automated verification:

- Run the existing project test suite.
- Add focused tests only if JavaScript behavior is refactored into testable units or backend response shape changes.

## Out of Scope

- New authentication model.
- New tenant APIs.
- Historical analytics.
- Database schema changes.
- True wildcard TLS automation.
- Multi-user roles or audit trails.
