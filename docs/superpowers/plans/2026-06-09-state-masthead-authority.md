# State Masthead Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the tenant state header so the single browse menu and masthead feel more formal, premium, and newsroom-like without changing routing or content flow.

**Architecture:** Keep the existing state page structure and request data flow intact: `src/middleware/subdomain.js` still populates `req.subdomain`, `req.tenant`, and `req.state`, while the live tenant router in `src/routes/state-public.js` renders `views/state/index.html` through `src/render/pipeline.js`. The only changes are presentation-layer updates to the shared state header template and CSS so the brand block, browse control, and dropdown panel look more authoritative.

**Tech Stack:** Node.js, Express, vanilla HTML templates, shared CSS in `public/css/main.css`, existing state rendering pipeline.

---

### Task 1: Tighten the state masthead markup

**Files:**
- Modify: `views/tenant/header.html`
- Test: `test/tenant-route.test.js`

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../src/render/template');

test('tenant header renders an authoritative browse masthead', () => {
  const html = render('tenant/header.html', {
    STATE_NAME: 'Washington',
    STATE_SLUG: 'washington',
    CANONICAL_HOST: 'washington.blotter.host',
    REQUEST_PATH: '/',
    PAGE_TITLE: 'Washington Blotter',
    PAGE_DESCRIPTION: 'Public safety blotter for Washington.',
    ACCENT_COLOR: '#1f2933',
    AGENCY: 'Washington State Patrol',
  });

  assert.match(html, /Browse/);
  assert.match(html, /Washington Blotter/);
  assert.match(html, /Washington State Patrol/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tenant-route.test.js`
Expected: FAIL because the current header markup is still the prior version and does not yet present the revised browse control and brand treatment.

- [ ] **Step 3: Write minimal implementation**

Update `views/tenant/header.html` so the header uses a more formal masthead structure:

```html
<header class="site-header site-header--authority">
  <div class="site-header__inner">
    <a class="site-header__brand" href="/">
      <span class="site-header__state">{{STATE_NAME}}</span>
      <span class="site-header__word">Blotter</span>
    </a>
    <button class="nav-toggle nav-toggle--authority" type="button" aria-controls="primary-nav" aria-expanded="false" data-nav-toggle>
      <span class="nav-toggle__label">Browse</span>
      <span class="nav-toggle__subtext">Network</span>
      <span class="nav-toggle__caret" aria-hidden="true"></span>
    </button>
    <nav class="site-nav site-nav--authority" id="primary-nav" data-nav>
      <a class="site-nav__link" href="/">Today</a>
      <a class="site-nav__link" href="/archive">Archive</a>
      <a class="site-nav__link" href="/about">About</a>
      <a class="site-nav__link" href="https://blotter.host">Network</a>
    </nav>
  </div>
  <p class="site-header__agency">Sourced from {{AGENCY}}</p>
</header>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tenant-route.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add views/tenant/header.html test/tenant-route.test.js
git commit -m "feat: refine tenant masthead"
```

### Task 2: Restyle the browse control and dropdown

**Files:**
- Modify: `public/css/main.css`
- Test: `test/tenant-route.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('tenant header includes authority styling hooks', () => {
  const html = render('tenant/header.html', {
    STATE_NAME: 'Washington',
    STATE_SLUG: 'washington',
    CANONICAL_HOST: 'washington.blotter.host',
    REQUEST_PATH: '/',
    PAGE_TITLE: 'Washington Blotter',
    PAGE_DESCRIPTION: 'Public safety blotter for Washington.',
    ACCENT_COLOR: '#1f2933',
    AGENCY: 'Washington State Patrol',
  });

  assert.match(html, /nav-toggle--authority/);
  assert.match(html, /site-nav--authority/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tenant-route.test.js`
Expected: FAIL until the new class names are added.

- [ ] **Step 3: Write minimal implementation**

Update the state-header styles in `public/css/main.css`:

```css
.site-header--authority {
  border-bottom: 1px solid color-mix(in srgb, var(--rule) 65%, transparent);
  background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(250,251,253,0.96));
  box-shadow: 0 8px 26px rgba(16, 20, 24, 0.04);
}

.site-header--authority .site-header__brand {
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.site-header--authority .site-header__state {
  font-weight: 800;
}

.nav-toggle--authority {
  background: linear-gradient(135deg, rgba(31,41,51,0.04), rgba(31,41,51,0.01));
  border-color: color-mix(in srgb, var(--accent) 18%, var(--rule));
}

.nav-toggle--authority .nav-toggle__subtext {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--fg-muted);
}

.site-nav--authority {
  box-shadow: 0 22px 48px rgba(16, 20, 24, 0.10);
  border-radius: 0 0 18px 18px;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tenant-route.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/css/main.css test/tenant-route.test.js
git commit -m "style: elevate tenant navigation"
```

### Task 3: Verify the live state pages and restart the service

**Files:**
- Modify: none
- Test: live HTTP check against `washington.blotter.host`

- [ ] **Step 1: Write the verification command**

```bash
systemctl restart blotter-host
curl -sk https://washington.blotter.host/ | sed -n '18,44p'
```

- [ ] **Step 2: Run the verification**

Expected:
- `Washington Blotter` appears in the state brand line and hero title
- `Browse` appears as the only menu control
- the dropdown looks more formal and newsroom-like

- [ ] **Step 3: Commit if any verification-related code changed**

If the restart reveals a rendering issue, fix it in the relevant template or CSS file and rerun:

```bash
node --test test/tenant-route.test.js
systemctl restart blotter-host
```

Expected: PASS and a clean live render.
