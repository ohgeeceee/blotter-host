# Production Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local admin settings surface for production readiness.

**Architecture:** Create a dependency-free settings module backed by `data/settings.json`, expose it through existing authenticated admin API routes, and render a compact production settings panel in the existing vanilla admin UI.

**Tech Stack:** Node.js CommonJS, Express, vanilla JavaScript, CSS, local JSON files.

---

### Task 1: Settings Module

**Files:**
- Create: `/root/blotter-host/src/control/settings.js`
- Create: `/root/blotter-host/test/settings.test.js`

- [ ] Write failing tests for default settings, save/load behavior, and readiness check shape.
- [ ] Implement `getSettings`, `saveSettings`, `getReadiness`, and `getStateLaunchRows`.
- [ ] Run `node --test /root/blotter-host/test/settings.test.js`.

### Task 2: Admin API

**Files:**
- Modify: `/root/blotter-host/src/control/api.js`

- [ ] Add `GET /settings`.
- [ ] Add `POST /settings` behind the existing XHR guard.
- [ ] Return `{ ok, settings, readiness, states }`.

### Task 3: Admin UI

**Files:**
- Modify: `/root/blotter-host/views/admin/index.html`
- Modify: `/root/blotter-host/public/js/admin.js`
- Modify: `/root/blotter-host/public/css/admin.css`

- [ ] Add production settings markup.
- [ ] Load settings on page startup.
- [ ] Save settings through `/admin/api/settings`.
- [ ] Render readiness checks and state launch summary.

### Task 4: Verification

**Files:**
- Read and run local app files.

- [ ] Run all Node tests.
- [ ] Restart `blotter-host.service`.
- [ ] Verify `/admin/api/settings` requires auth indirectly by checking admin login behavior remains intact.
- [ ] Verify authenticated admin page still loads.

## Notes

- Keep all files local.
- Do not stage, commit, push, or publish.
