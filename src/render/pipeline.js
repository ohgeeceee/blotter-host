'use strict';

/**
 * pipeline.js — Multi-Tenant Rendering Pipeline & Asset Switcher
 * --------------------------------------------------------------
 * Sits on top of the minimal {{TOKEN}} engine in src/render/template.js.
 * The engine knows nothing about tenants; the pipeline does.
 *
 * Usage from a route handler:
 *
 *   const html = renderForState(req.tenant, 'state/index.html', {
 *     BODY_CONTENT: ...         // anything page-specific
 *   });
 *   res.type('html').send(html);
 *
 * Per-state customization comes from `tenant.seo`, `tenant.bailBonds`, and
 * (in a future iteration) `tenant.theme`. Anything not present on the
 * tenant falls back to the network-wide defaults below. That means a new
 * state can be added to tenants.json with only the required fields and
 * it will render correctly using the defaults — no template duplication.
 *
 * Placeholders the layout expects (set by this pipeline):
 *   {{PAGE_TITLE}}              <title>
 *   {{PAGE_DESCRIPTION}}        meta description
 *   {{CANONICAL_HOST}}          https://washington.blotter.host
 *   {{REQUEST_HOST}}            raw Host header
 *   {{REQUEST_PATH}}            req.path
 *   {{ACCENT_COLOR}}            theme accent (hex)
 *   {{THEME_COLOR}}             alias of {{ACCENT_COLOR}} for new code
 *   {{STATE_NAME}}              display name ("Washington")
 *   {{STATE_SLUG}}              lowercase slug ("washington")
 *   {{STATE_CODE}}              2-letter postal code ("WA")
 *   {{AGENCY}}                  public.agency
 *   {{TAGLINE}}                 public.tagline
 *   {{HEADER_CUSTOM_HTML}}      optional per-state header block
 *   {{BAIL_BOND_HTML}}          optional per-state bail bond ad block
 *   {{{BODY}}}                  raw, unescaped — the inner view's HTML
 */

const { render } = require('./template');
const { ROOT_DOMAIN } = require('../middleware/subdomain');

// ---------------------------------------------------------------------------
// Default schemas — every tenant falls back to these unless they override.
// ---------------------------------------------------------------------------

const DEFAULT_THEME = Object.freeze({
  accent: '#1f2933',
  accentForeground: '#ffffff',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
});

const DEFAULT_SEO = Object.freeze({
  // {STATE_NAME} and {STATE_CODE} are substituted at render time.
  title: '{STATE_NAME} Blotter — public safety digest',
  description: 'Public safety blotter for {STATE_NAME}. Plain-language summaries of arrests, incidents, and court activity.',
  ogImage: null,
  twitterCard: 'summary_large_image',
});

const DEFAULT_HEADER = Object.freeze({
  showAgency: true,
  showNetworkLink: true,
  customHtml: '',         // raw HTML block appended to the header
});

const DEFAULT_BAIL_BONDS = Object.freeze({
  enabled: false,
  providerId: null,
  defaultText: '',
  ctaUrl: null,
  disclaimer:
    'Paid advertisement. blotter.host does not endorse any bail bond agent. ' +
    'For legal advice, consult a licensed attorney in {STATE_NAME}.',
});

function titleizeSlug(slug) {
  return String(slug || '')
    .trim()
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

function substitute(str, vars) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

function mergeTheme(tenant) {
  return Object.assign({}, DEFAULT_THEME, (tenant && tenant.theme) || {});
}

function mergeSeo(tenant, vars) {
  const override = (tenant && tenant.seo) || {};
  const merged = Object.assign({}, DEFAULT_SEO, override);
  // {STATE_NAME} substitution happens here, not in the template engine,
  // because we want different vars per call.
  return {
    title: substitute(merged.title, vars),
    description: substitute(merged.description, vars),
    ogImage: merged.ogImage,
    twitterCard: merged.twitterCard,
  };
}

function mergeHeader(tenant) {
  return Object.assign({}, DEFAULT_HEADER, (tenant && tenant.header) || {});
}

function mergeBailBonds(tenant, vars) {
  const merged = Object.assign({}, DEFAULT_BAIL_BONDS, (tenant && tenant.bailBonds) || {});
  if (!merged.enabled) return null;
  return {
    providerId: merged.providerId,
    text: substitute(merged.defaultText || '', vars),
    ctaUrl: merged.ctaUrl,
    disclaimer: substitute(merged.disclaimer, vars),
  };
}

// ---------------------------------------------------------------------------
// HTML builders for the optional per-state blocks
// ---------------------------------------------------------------------------

function buildHeaderCustomHtml(header) {
  if (!header || !header.customHtml) return '';
  // Caller is responsible for sanitizing — we trust the tenants.json payload
  // because the registry is operator-curated, not user-generated.
  return header.customHtml;
}

function buildBailBondHtml(ad, stateCode) {
  if (!ad) return '';
  // Minimal, semantically clear ad unit. Designed to fail closed: missing
  // providerId or text renders nothing.
  if (!ad.providerId && !ad.text) return '';
  const cta = ad.ctaUrl
    ? `<a class="bail-bond__cta" href="${escapeAttr(ad.ctaUrl)}" rel="sponsored noopener" target="_blank">Get help</a>`
    : '';
  return [
    '<aside class="bail-bond" data-provider="' + escapeAttr(ad.providerId || '') + '" data-state="' + escapeAttr(stateCode || '') + '">',
    '  <p class="bail-bond__label">Sponsored</p>',
    ad.text ? '  <p class="bail-bond__text">' + escapeHtml(ad.text) + '</p>' : '',
    cta,
    '  <p class="bail-bond__disclaimer">' + escapeHtml(ad.disclaimer) + '</p>',
    '</aside>',
  ].filter(Boolean).join('\n');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Render a full page for a tenant.
 *
 *   const html = renderForState(req.tenant, 'state/index.html', {
 *     BODY_CONTENT: '<p>Hello</p>',
 *   });
 *
 * @param {object|null} tenant  frozen registry entry (or null for a "default" render)
 * @param {string}      viewName  template path inside views/, e.g. 'state/index.html'
 * @param {object}      [extra]   page-specific context to merge in last
 * @returns {string} final HTML
 */
function renderForState(tenant, viewName, extra = {}) {
  const slug = (tenant && tenant.slug) || '';
  const code = (tenant && tenant.code) || '';
  const name = String((tenant && tenant.name) || '').trim() || titleizeSlug(slug);
  const publicCfg = (tenant && tenant.public) || {};
  const vars = { STATE_NAME: name, STATE_CODE: code, STATE_SLUG: slug };

  const theme = mergeTheme(tenant);
  const seo = mergeSeo(tenant, vars);
  const header = mergeHeader(tenant);
  const bailBonds = mergeBailBonds(tenant, vars);

  const canonicalHost = slug ? `${slug}.${ROOT_DOMAIN}` : ROOT_DOMAIN;
  const accent = theme.accent || DEFAULT_THEME.accent;

  // Inner view: render with a minimal context — the inner view shouldn't have
  // to know about SEO/header/bail-bonds, just page content.
  const innerCtx = Object.assign({}, vars, {
    AGENCY: publicCfg.agency || 'Pending partnership',
    TAGLINE: publicCfg.tagline || 'This state is being onboarded.',
    BLOTTER_LIST: publicCfg.blotters || [],
    HAS_BLOTTERS: Boolean(publicCfg.blotters && publicCfg.blotters.length),
  }, extra);
  const innerHtml = render(viewName, innerCtx);

  // Layout context: all the chrome.
  const layoutCtx = Object.assign({}, innerCtx, {
    PAGE_TITLE: seo.title,
    PAGE_DESCRIPTION: seo.description,
    OG_IMAGE: seo.ogImage,
    TWITTER_CARD: seo.twitterCard,
    CANONICAL_HOST: canonicalHost,
    REQUEST_HOST: extra.REQUEST_HOST || canonicalHost,
    REQUEST_PATH: extra.REQUEST_PATH || '/',
    ACCENT_COLOR: accent,
    THEME_COLOR: accent,
    FONT_FAMILY: theme.fontFamily,
    HEADER_CUSTOM_HTML: buildHeaderCustomHtml(header),
    BAIL_BOND_HTML: buildBailBondHtml(bailBonds, code),
    BODY: innerHtml,
  });

  return render('layout.html', layoutCtx);
}

// ---------------------------------------------------------------------------
// Exposed for tests / other callers
// ---------------------------------------------------------------------------

module.exports = {
  renderForState,
  // Schemas, exported so a future admin UI can render "current config" panels.
  DEFAULT_THEME,
  DEFAULT_SEO,
  DEFAULT_HEADER,
  DEFAULT_BAIL_BONDS,
  // Pure helpers.
  substitute,
  mergeTheme,
  mergeSeo,
  mergeHeader,
  mergeBailBonds,
  buildHeaderCustomHtml,
  buildBailBondHtml,
};
