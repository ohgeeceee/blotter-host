# State Pages Headline-Heavy Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tenant state pages feel more headline-driven and editorial by enlarging the hero, tightening supporting metadata, and reducing competing chrome above the fold without changing routing or content.

**Architecture:** Keep the current state rendering pipeline intact. The tenant route still feeds `req.subdomain` and tenant data into `src/render/pipeline.js`, which renders `views/state/index.html` through the shared layout. The change is strictly presentational: adjust the state template and supporting CSS so the hero dominates the page and the article feed begins sooner.

**Tech Stack:** Node.js, Express, vanilla HTML templates, shared CSS in `public/css/main.css`, existing state rendering pipeline.

---

### Task 1: Increase the state hero’s headline weight

**Files:**
- Modify: `views/state/index.html`
- Test: `test/tenant-route.test.js`

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../src/render/template');

test('state homepage emphasizes the headline over the support text', () => {
  const html = render('state/index.html', {
    STATE_NAME: 'Washington',
    AGENCY: 'Washington State Patrol',
    TAGLINE: 'Public safety blotter for the Evergreen State.',
    BLOTTER_LIST_HTML: '<li>Example blotter</li>',
  });

  assert.match(html, /Washington Blotter/);
  assert.match(html, /Public safety blotter for the Evergreen State\./);
  assert.match(html, /Recent reports/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tenant-route.test.js`
Expected: FAIL because the current template still uses the existing hero spacing and hierarchy.

- [ ] **Step 3: Write minimal implementation**

Update `views/state/index.html` so the hero reads like a front-page lead:

```html
<section class="hero hero--state">
  <p class="hero__eyebrow">{{AGENCY}}</p>
  <h1 class="hero__title">{{STATE_NAME}} Blotter</h1>
  <p class="hero__tagline">{{TAGLINE}}</p>
</section>

<section class="blotters blotters--state" aria-labelledby="recent-heading">
  <div class="blotters__head">
    <h2 id="recent-heading" class="blotters__heading">Recent reports</h2>
    <a class="blotters__archive" href="/archive">View archive &rarr;</a>
  </div>
  <ul class="blotters__list">
    {{{BLOTTER_LIST_HTML}}}
  </ul>
</section>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tenant-route.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add views/state/index.html test/tenant-route.test.js
git commit -m "feat: emphasize state homepage headline"
```

### Task 2: Restyle the state homepage for stronger hierarchy

**Files:**
- Modify: `public/css/main.css`
- Test: `test/tenant-route.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('state homepage uses headline-forward hero classes', () => {
  const html = render('state/index.html', {
    STATE_NAME: 'Washington',
    AGENCY: 'Washington State Patrol',
    TAGLINE: 'Public safety blotter for the Evergreen State.',
    BLOTTER_LIST_HTML: '<li>Example blotter</li>',
  });

  assert.match(html, /hero--state/);
  assert.match(html, /blotters--state/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tenant-route.test.js`
Expected: FAIL until the new class names are present.

- [ ] **Step 3: Write minimal implementation**

Add the headline-heavy styling in `public/css/main.css`:

```css
.hero--state {
  padding: 24px 0 18px;
  border-bottom: 1px solid color-mix(in srgb, var(--rule) 80%, transparent);
  margin-bottom: 16px;
}

.hero--state .hero__eyebrow {
  margin-bottom: 6px;
  font-size: 11px;
  letter-spacing: 0.14em;
}

.hero--state .hero__title {
  max-width: 12ch;
  font-size: clamp(3rem, 6.2vw, 5.2rem);
  line-height: 0.92;
  letter-spacing: -0.06em;
  margin-bottom: 10px;
}

.hero--state .hero__tagline {
  max-width: 50ch;
  font-size: 1rem;
  line-height: 1.55;
}

.blotters--state {
  margin-top: 16px;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tenant-route.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/css/main.css test/tenant-route.test.js
git commit -m "style: make state pages headline-heavy"
```

### Task 3: Verify the live state page and restart the service

**Files:**
- Modify: none
- Test: live HTTP check against `washington.blotter.host`

- [ ] **Step 1: Write the verification command**

```bash
systemctl restart blotter-host
curl -sk https://washington.blotter.host/ | sed -n '18,60p'
```

- [ ] **Step 2: Run the verification**

Expected:
- The state hero dominates the page
- `Washington Blotter` reads as the primary headline
- `Recent reports` starts closer to the hero
- The Browse masthead remains unchanged and authoritative

- [ ] **Step 3: Commit if any verification-related code changed**

If the live render looks off, adjust the state template or CSS, rerun:

```bash
node --test test/tenant-route.test.js
systemctl restart blotter-host
```

Expected: PASS and a cleaner live front page.

