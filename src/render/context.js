'use strict';

/**
 * Build the render context for a tenant's public-facing page.
 *
 * We deliberately do NOT route through src/tenants.js (the operational
 * loader used by the control room) because that loader freezes a whitelist
 * of fields (slug, name, dbPath, heartbeat, ...) and discards the rest.
 * Public-facing fields (agency, tagline, accent, blotters) live in the same
 * tenants.json file but are not part of the operational contract, so we
 * read them directly here.
 *
 * If the operational loader ever grows a `public` accessor, this module
 * can be reduced to a one-liner that delegates to it.
 */

const fs = require('fs');
const path = require('path');

const TENANTS_PATH = path.resolve(__dirname, '..', '..', 'tenants.json');
const ROOT_DOMAIN = 'blotter.host';

let cached = { mtimeMs: 0, bySlug: null };

function readPublicBySlug() {
  const stat = fs.statSync(TENANTS_PATH);
  if (cached.bySlug && cached.mtimeMs === stat.mtimeMs) return cached.bySlug;

  const raw = fs.readFileSync(TENANTS_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const bySlug = Object.create(null);
  for (const t of parsed.tenants || []) {
    if (t && t.slug) bySlug[t.slug] = t;
  }
  cached = { mtimeMs: stat.mtimeMs, bySlug };
  return bySlug;
}

function formatHumanDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[parseInt(m[2], 10) - 1] || m[2];
  return `${month} ${parseInt(m[3], 10)}, ${m[1]}`;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function renderBlotterListHTML(blotters) {
  if (!blotters || !blotters.length) {
    return '<li class="blotter-item blotter-item--empty">No blotters published yet. Check back soon.</li>';
  }
  return blotters.map((b) => `
        <li class="blotter-item">
          <a class="blotter-item__link" href="/blotter/${b.id}">
            <span class="blotter-item__date">${formatHumanDate(b.date)}</span>
            <span class="blotter-item__title">${b.title}</span>
          </a>
          <p class="blotter-item__summary">${b.summary}</p>
        </li>
      `).join('');
}

function buildContext(slug, host, requestPath) {
  const all = readPublicBySlug();
  const tenant = all[slug] || null;
  const pub = (tenant && tenant.public) || {};

  const displayName = (tenant && tenant.name) || capitalize(slug);

  return {
    STATE_SLUG: slug,
    STATE_NAME: displayName,
    CANONICAL_HOST: `${slug}.${ROOT_DOMAIN}`,
    REQUEST_HOST: host,
    REQUEST_PATH: requestPath || '/',
    AGENCY: pub.agency || 'Pending partnership',
    TAGLINE: pub.tagline || 'This state is being onboarded.',
    ACCENT_COLOR: pub.accent || '#1f2933',
    PAGE_TITLE: `${displayName} Blotter — public safety digest`,
    PAGE_DESCRIPTION: pub.tagline || `Public safety blotter for ${displayName}.`,
    BLOTTER_LIST: pub.blotters || [],
    BLOTTER_LIST_HTML: renderBlotterListHTML(pub.blotters),
    HAS_BLOTTERS: Boolean(pub.blotters && pub.blotters.length),
  };
}

module.exports = { buildContext, formatHumanDate, readPublicBySlug };
