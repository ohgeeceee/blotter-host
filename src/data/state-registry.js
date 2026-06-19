'use strict';

/**
 * state-registry.js
 * -----------------
 * Runtime registry of every active state in the blotter.host network.
 *
 *   - The ONLY mutable source of truth is `tenants.json` at the project root.
 *   - We re-read that file only when its mtime changes (cheap, dependency-free).
 *   - To add a state, drop one new object into `tenants.json` and reload
 *     the process (or, in a future iteration, SIGHUP). No code changes.
 *
 * Schema for one tenant (see tenants.json for a real example):
 *
 *   {
 *     "slug":   "washington",                       // <subdomain>.blotter.host
 *     "code":   "WA",                               // 2-letter US postal code
 *     "name":   "Washington",                       // display name
 *     "public": { ... },                            // public-site payload
 *     "seo":    { ... },                            // optional SEO overrides
 *     "bailBonds": { ... },                         // optional ad config
 *   }
 *
 * `code` is what flows into PostgreSQL's `app.current_state_id` GUC.
 * If a tenant omits `code`, we fall back to `slug.toUpperCase().slice(0,2)`,
 * but you should set it explicitly — postal codes and slugs don't always
 * agree (e.g. "DC", "NH", "RI").
 */

const fs = require('fs');
const path = require('path');

const TENANTS_PATH = path.resolve(__dirname, '..', '..', 'tenants.json');

const STATE_CODE_RE = /^[A-Z]{2}$/;
const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_SUBDOMAINS = new Set([
  'www', 'api', 'cdn', 'mail', 'admin', 'static', 'auth', 'sso',
]);

let cache = { mtimeMs: 0, bySlug: new Map(), byCode: new Map(), all: [] };

function deriveCode(slug, explicit) {
  if (typeof explicit === 'string' && STATE_CODE_RE.test(explicit)) return explicit;
  if (typeof slug !== 'string' || slug.length < 2) return null;
  return slug.toUpperCase().slice(0, 2);
}

function buildRegistry() {
  const raw = fs.readFileSync(TENANTS_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  const bySlug = new Map();
  const byCode = new Map();
  const all = [];
  const errors = [];

  for (const t of parsed.tenants || []) {
    if (!t || typeof t.slug !== 'string') continue;

    const slug = t.slug.toLowerCase();
    const code = deriveCode(slug, t.code);

    if (!SUBDOMAIN_RE.test(slug))              { errors.push(`bad slug "${slug}"`); continue; }
    if (!code)                                 { errors.push(`bad/missing code for slug "${slug}"`); continue; }
    if (bySlug.has(slug))                      { errors.push(`duplicate slug "${slug}"`); continue; }
    if (byCode.has(code))                      { errors.push(`duplicate state code "${code}" (slugs: ${slug} vs ${byCode.get(code).slug})`); continue; }
    if (RESERVED_SUBDOMAINS.has(slug))         { errors.push(`slug "${slug}" is reserved`); continue; }

    const entry = Object.freeze({
      slug,
      code,
      name: t.name || slug,
      public: t.public || {},
      seo: t.seo || null,
      bailBonds: t.bailBonds || null,
      ops: {
        dbPath: t.dbPath || null,
        heartbeatPath: t.heartbeatPath || null,
        scraperCommand: t.scraperCommand || null,
        scraperCwd: t.scraperCwd || null,
        notes: t.notes || '',
      },
    });

    bySlug.set(slug, entry);
    byCode.set(code, entry);
    all.push(entry);
  }

  if (errors.length) {
    // Don't crash on a bad tenant — log and skip. The dashboard needs to keep
    // working even if one state has a typo in tenants.json.
    console.error('[state-registry] skipped entries:', errors);
  }

  return { bySlug, byCode, all };
}

function load() {
  const stat = fs.statSync(TENANTS_PATH);
  if (cache.mtimeMs === stat.mtimeMs) return cache;
  cache = { mtimeMs: stat.mtimeMs, ...buildRegistry() };
  return cache;
}

function getBySlug(slug) {
  if (typeof slug !== 'string') return null;
  return load().bySlug.get(slug.toLowerCase()) || null;
}

function getByCode(code) {
  if (typeof code !== 'string') return null;
  return load().byCode.get(code.toUpperCase()) || null;
}

function listAll()      { return load().all.slice(); }
function listCodes()    { return load().all.map((t) => t.code); }
function listSlugs()    { return load().all.map((t) => t.slug); }

function isReservedSubdomain(slug) {
  return RESERVED_SUBDOMAINS.has(String(slug || '').toLowerCase());
}

function _resetCache() {
  cache = { mtimeMs: 0, bySlug: new Map(), byCode: new Map(), all: [] };
}

module.exports = {
  RESERVED_SUBDOMAINS,
  STATE_CODE_RE,
  SUBDOMAIN_RE,
  getBySlug,
  getByCode,
  listAll,
  listCodes,
  listSlugs,
  isReservedSubdomain,
  _resetCache,
};
