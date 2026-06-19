'use strict';

/**
 * subdomain.js — Global Subdomain Interceptor
 * --------------------------------------------
 * Runs before any router. Inspects the `Host` header and annotates the
 * request with the tenant it belongs to (or, for the apex, with the flag
 * that says "this is the admin/control surface").
 *
 *   req.isRootAdmin   true iff host is the apex (blotter.host or www.blotter.host)
 *   req.stateContext  'WA' | 'MT' | ... for a known state subdomain, else null
 *   req.tenant        frozen registry entry (code, name, public, seo, bailBonds) or null
 *
 *   Legacy aliases kept for the control-room code that already exists:
 *   req.subdomain     the slug (e.g. 'washington') or null
 *   req.tenantSlug    alias of req.subdomain
 *   req.isMainDomain  true iff req.isRootAdmin
 *
 *   Status code policy:
 *     400  — Host header missing or malformed
 *     404  — Host is *.blotter.host but the subdomain is not in the registry
 *            (rendered as a clean HTML page; JSON for API clients)
 *     421  — Host is neither the apex nor a *.blotter.host child
 *            (host is outside this network entirely)
 */

const { render } = require('../render/template');
const stateRegistry = require('../data/state-registry');

const ROOT_DOMAIN = 'blotter.host';
const ADMIN_HOST = `admin.${ROOT_DOMAIN}`;
const APEX_ALIASES = new Set([ROOT_DOMAIN, `www.${ROOT_DOMAIN}`]);

function normalizeHost(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let h = raw.toLowerCase().trim();
  const colon = h.indexOf(':');
  if (colon !== -1) h = h.slice(0, colon);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h || null;
}

/**
 * Pure parser — given a hostname, returns one of:
 *   { kind: 'apex' }
 *   { kind: 'state', slug, tenant }
 *   { kind: 'unknown_subdomain', slug }
 *   { kind: 'reserved', slug }
 *   { kind: 'foreign', host }
 *   { kind: 'malformed', reason }
 */
function classifyHost(host) {
  if (!host) return { kind: 'malformed', reason: 'empty host' };

  if (host === ADMIN_HOST) return { kind: 'admin' };
  if (APEX_ALIASES.has(host)) return { kind: 'apex' };

  const suffix = '.' + ROOT_DOMAIN;
  if (!host.endsWith(suffix)) return { kind: 'foreign', host };

  const prefix = host.slice(0, host.length - suffix.length);
  if (!prefix) return { kind: 'apex' };

  if (stateRegistry.isReservedSubdomain(prefix)) {
    return { kind: 'reserved', slug: prefix };
  }

  if (!stateRegistry.SUBDOMAIN_RE.test(prefix)) {
    return { kind: 'malformed', reason: 'invalid subdomain prefix' };
  }

  const tenant = stateRegistry.getBySlug(prefix);
  if (!tenant) return { kind: 'unknown_subdomain', slug: prefix };
  return { kind: 'state', slug: prefix, tenant };
}

function parseStateFromHost(host) {
  const normalized = normalizeHost(host);
  const cls = classifyHost(normalized);

  if (cls.kind === 'state') {
    return {
      isRootDomain: false,
      state: cls.slug,
      host: normalized,
    };
  }

  return {
    isRootDomain: true,
    state: null,
    host: normalized,
  };
}

function wantsJson(req) {
  const accept = String(req.headers.accept || '');
  return req.path.startsWith('/api/') || accept.includes('application/json');
}

function renderUnknownSubdomainPage(host) {
  // Lean on the existing layout so the 404 doesn't look unbranded.
  // We deliberately don't read stateRegistry here — we don't know who to render for.
  const ctx = {
    PAGE_TITLE: 'State not found — blotter.host',
    STATE_NAME: '',
    STATE_SLUG: '',
    CANONICAL_HOST: ROOT_DOMAIN,
    REQUEST_HOST: host,
    REQUEST_PATH: '/',
    ACCENT_COLOR: '#1f2933',
    PAGE_DESCRIPTION: 'This state subdomain is not part of the blotter.host network.',
    AGENCY: '',
    TAGLINE: '',
    UNKNOWN_HOST: host,
    BODY: [
      '<section class="hero">',
      '  <p class="hero__eyebrow">404</p>',
      '  <h1 class="hero__title">No state registered at <code>' + host + '</code></h1>',
      '  <p class="hero__tagline">',
      '    This subdomain isn\'t part of the blotter.host network. ',
      '    The network currently covers ' + stateRegistry.listAll().length + ' states.',
      '  </p>',
      '  <p><a href="https://' + ROOT_DOMAIN + '">Back to blotter.host &rarr;</a></p>',
      '</section>',
    ].join('\n'),
  };
  return render('layout.html', ctx);
}

/**
 * Express middleware. Always sets both the new and legacy fields so the
 * control-room code (which reads req.subdomain / req.isMainDomain) keeps
 * working unchanged.
 */
function extractSubdomain(req, res, next) {
  const host = normalizeHost(req.headers.host);
  if (!host) return res.status(400).type('text').send('Missing or invalid Host header');

  const cls = classifyHost(host);

  switch (cls.kind) {
    case 'apex': {
      req.isRootAdmin = true;
      req.isAdminHost = true;
      req.stateContext = null;
      req.tenant = null;
      req.subdomain = null;
      req.tenantSlug = null;
      req.isMainDomain = true;
      return next();
    }

    case 'admin': {
      req.isRootAdmin = true;
      req.isAdminHost = true;
      req.stateContext = null;
      req.tenant = null;
      req.subdomain = null;
      req.tenantSlug = null;
      req.isMainDomain = true;
      return next();
    }

    case 'state': {
      req.isRootAdmin = false;
      req.isAdminHost = false;
      req.stateContext = cls.tenant.code;
      req.tenant = cls.tenant;
      req.subdomain = cls.slug;
      req.tenantSlug = cls.slug;
      req.isMainDomain = false;
      return next();
    }

    case 'unknown_subdomain': {
      if (wantsJson(req)) {
        return res.status(404).json({
          error: 'state_not_found',
          host,
          slug: cls.slug,
          hint: 'Add this slug to tenants.json to register the state.',
        });
      }
      return res.status(404).type('html').send(renderUnknownSubdomainPage(host));
    }

    case 'reserved': {
      return res.status(421).type('text').send('Host not served by this network');
    }

    case 'malformed': {
      return res.status(400).type('text').send('Malformed host: ' + (cls.reason || 'unknown'));
    }

    case 'foreign':
    default: {
      return res.status(421).type('text').send('Host not served by this network');
    }
  }
}

function isStrictRootHost(req) {
  const host = normalizeHost(req.headers.host);
  return host !== null && APEX_ALIASES.has(host);
}

function isAdminHost(req) {
  const host = normalizeHost(req.headers.host);
  return host !== null && (host === ADMIN_HOST || APEX_ALIASES.has(host));
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function subdomainMiddleware(req, res, next) {
  const normalized = normalizeHost(req.headers.host);
  if (!normalized) {
    return res.status(400).type('text').send('Missing or invalid Host header');
  }
  const cls = classifyHost(normalized);
  const parsed = parseStateFromHost(req.headers.host);
  req.state = {
    name: parsed.state,
    slug: parsed.state,
    isRootDomain: parsed.isRootDomain,
    host: parsed.host,
    rootDomain: ROOT_DOMAIN,
  };
  req.subdomain = cls.kind === 'state' ? cls.slug : null;
  req.tenantSlug = req.subdomain;
  req.tenant = cls.kind === 'state' ? cls.tenant : null;
  req.stateContext = req.tenant ? req.tenant.code : null;
  req.isMainDomain = cls.kind === 'apex';
  req.isAdminHost = cls.kind === 'admin';
  req.isRootAdmin = cls.kind === 'apex' || cls.kind === 'admin';

  switch (cls.kind) {
    case 'unknown_subdomain':
      if (wantsJson(req)) {
        return res.status(404).json({
          error: 'state_not_found',
          host: normalized,
          slug: cls.slug,
          hint: 'Add this slug to tenants.json to register the state.',
        });
      }
      return res.status(404).type('html').send(renderUnknownSubdomainPage(normalized));
    case 'reserved':
      return res.status(421).type('text').send('Host not served by this network');
    case 'malformed':
      return res.status(400).type('text').send('Malformed host: ' + (cls.reason || 'unknown'));
    case 'foreign':
      return res.status(421).type('text').send('Host not served by this network');
    default:
      break;
  }
  return next();
}

module.exports = {
  ROOT_DOMAIN,
  ADMIN_HOST,
  APEX_ALIASES,
  parseStateFromHost,
  subdomainMiddleware,
  extractSubdomain,
  isStrictRootHost,
  isAdminHost,
  classifyHost,
  normalizeHost,
  capitalize,
};
