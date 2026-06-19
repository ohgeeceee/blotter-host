'use strict';

/**
 * root.js — Root Domain Unified Hub
 * ---------------------------------
 * Mounted only when req.isRootAdmin is true (the apex: blotter.host or
 * www.blotter.host). Serves:
 *
 *   GET  /                           — network landing page
 *   GET  /api/states                 — JSON list of every active state
 *   GET  /api/cross-state-search     — search across ALL 50 states at once
 *   GET  /login                      — reader login form
 *   POST /login                      — reader login handler
 *   GET  /register                   — reader register form
 *   POST /register                   — reader register handler
 *   GET  /logout                     — clear reader cookie
 *   GET  /network                    — state directory
 *   GET  /about                      — network info
 *   GET  /healthz                    — surface + DB health
 *
 * Cross-state search uses db.adminQuery() which sets app.current_state_id = '*'
 * so the RLS policy allows every state's rows. It should remain gated behind
 * admin auth until the PII auditor gives clearance for public name search.
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const express = require('express');
const { render } = require('../render/template');
const stateRegistry = require('../data/state-registry');
const db = require('../db');
const pg = require('../db/pg');
const { ROOT_DOMAIN } = require('../middleware/subdomain');
const { slugifyCounty, titleizeCounty } = require('../lib/county-extractor');

const router = express.Router();

// ---------------------------------------------------------------------------
// Reader auth (lightweight, SQLite-backed)
// ---------------------------------------------------------------------------
const READER_COOKIE = 'blotter_reader';
const READER_TTL_SECONDS = 60 * 60 * 24 * 30;
const VERIFICATION_TTL_SECONDS = 60 * 60 * 24; // 24 hours
const BCRYPT_COST = 12;
const MIN_PASSWORD_LENGTH = 12;

function getReaderSecret() {
  const secret = String(process.env.READER_COOKIE_SECRET || '').trim();
  if (!secret) {
    throw new Error('READER_COOKIE_SECRET must be set for reader auth');
  }
  return secret;
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signReader(payload) {
  const secret = getReaderSecret();
  return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

function verifyReader(token) {
  const secret = getReaderSecret();
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (Buffer.from(signature).length !== Buffer.from(expected).length) return null;
  const sigBuf = Buffer.from(signature, 'base64url');
  const expBuf = Buffer.from(expected, 'base64url');
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (Number.isInteger(claims.exp) && claims.exp > Math.floor(Date.now() / 1000)) {
      return claims;
    }
  } catch (_err) {}
  return null;
}

function cookieFlags() {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if ((process.env.NODE_ENV || 'production') === 'production') {
    flags.push('Secure');
  }
  return flags.join('; ');
}

function makeReaderCookie(email) {
  const payload = base64url(JSON.stringify({ sub: email, exp: Math.floor(Date.now() / 1000) + READER_TTL_SECONDS }));
  return `${READER_COOKIE}=${signReader(payload)}; ${cookieFlags()}; Max-Age=${READER_TTL_SECONDS}`;
}

function clearReaderCookie() {
  return `${READER_COOKIE}=; Path=/; Max-Age=0; ${cookieFlags()}`;
}

function ensureReaderUsersTable() {
  const conn = db.db;
  conn.exec(`
    CREATE TABLE IF NOT EXISTS reader_users (
      id                            INTEGER PRIMARY KEY AUTOINCREMENT,
      email                         TEXT NOT NULL UNIQUE,
      normalized_email              TEXT NOT NULL UNIQUE,
      password_hash                 TEXT NOT NULL,
      state_slug                    TEXT,
      email_verified_at             TEXT,
      verification_token            TEXT,
      verification_token_expires_at TEXT,
      created_at                    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // Backfill existing rows so the new UNIQUE normalized_email column doesn't break.
  try {
    conn.prepare("UPDATE reader_users SET normalized_email = lower(email) WHERE normalized_email IS NULL OR normalized_email = ''").run();
  } catch (_err) {
    // Ignore; column may already be populated.
  }
}

function currentReader(req) {
  const cookies = String(req.headers.cookie || '').split(';').map((part) => part.trim()).filter(Boolean).reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx !== -1) acc[part.slice(0, idx)] = decodeURIComponent(part.slice(idx + 1));
    return acc;
  }, {});
  return verifyReader(cookies[READER_COOKIE]);
}

function requireReader(req, res, next) {
  ensureReaderUsersTable();
  const claims = currentReader(req);
  if (!claims || !claims.sub) {
    return res.redirect(303, '/login');
  }
  const user = db.db.prepare('SELECT id, email, state_slug FROM reader_users WHERE email = ?').get(claims.sub);
  if (!user) {
    res.setHeader('Set-Cookie', clearReaderCookie());
    return res.redirect(303, '/login');
  }
  req.reader = user;
  return next();
}

function ensureReaderAlertsTable() {
  db.db.exec(`
    CREATE TABLE IF NOT EXISTS reader_alerts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      reader_id     INTEGER NOT NULL REFERENCES reader_users(id) ON DELETE CASCADE,
      alert_type    TEXT NOT NULL CHECK (alert_type IN ('county', 'keyword')),
      target        TEXT NOT NULL,
      frequency     TEXT NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily', 'weekly')),
      last_sent_at  TEXT,
      is_enabled    INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(reader_id, alert_type, target)
    )
  `);
  db.db.exec(`
    CREATE TABLE IF NOT EXISTS alert_digests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      reader_id     INTEGER NOT NULL REFERENCES reader_users(id) ON DELETE CASCADE,
      alert_ids     TEXT NOT NULL,
      matched_count INTEGER NOT NULL DEFAULT 0,
      digest_html   TEXT,
      sent_at       TEXT NOT NULL DEFAULT (datetime('now')),
      status        TEXT NOT NULL DEFAULT 'logged'
    )
  `);
}

function listReaderAlerts(readerId) {
  ensureReaderAlertsTable();
  return db.db.prepare(`
    SELECT id, alert_type, target, frequency, last_sent_at, is_enabled, created_at
      FROM reader_alerts
     WHERE reader_id = ?
     ORDER BY alert_type, target
  `).all(readerId);
}

function createReaderAlert(readerId, alertType, target, frequency) {
  ensureReaderAlertsTable();
  const normalizedTarget = String(target || '').trim().toLowerCase().slice(0, 200);
  if (!normalizedTarget) throw new Error('target is required');
  if (!['county', 'keyword'].includes(alertType)) throw new Error('invalid alert_type');
  const freq = frequency === 'weekly' ? 'weekly' : 'daily';
  const result = db.db.prepare(`
    INSERT INTO reader_alerts (reader_id, alert_type, target, frequency)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (reader_id, alert_type, target) DO UPDATE SET
      is_enabled = 1,
      frequency = excluded.frequency,
      updated_at = datetime('now')
    RETURNING id
  `).get(readerId, alertType, normalizedTarget, freq);
  return result;
}

function deleteReaderAlert(readerId, alertId) {
  ensureReaderAlertsTable();
  db.db.prepare('DELETE FROM reader_alerts WHERE id = ? AND reader_id = ?').run(alertId, readerId);
}

function countReaderAlerts(readerId) {
  ensureReaderAlertsTable();
  const row = db.db.prepare('SELECT COUNT(*) AS c FROM reader_alerts WHERE reader_id = ?').get(readerId);
  return row ? row.c : 0;
}

function normalizeKeyword(keyword) {
  return String(keyword || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 100);
}

// ---------------------------------------------------------------------------
// Anti-spam & rate limiting
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const rateLimitStore = new Map();

function rateLimitKey(ip, action) {
  return `${ip}:${action}`;
}

function isRateLimited(ip, action) {
  const key = rateLimitKey(ip, action);
  const now = Date.now();
  const record = rateLimitStore.get(key);
  if (!record) return false;
  if (now - record.first > RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.delete(key);
    return false;
  }
  return record.count >= RATE_LIMIT_MAX_ATTEMPTS;
}

function recordAttempt(ip, action) {
  const key = rateLimitKey(ip, action);
  const now = Date.now();
  const record = rateLimitStore.get(key);
  if (!record || now - record.first > RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(key, { first: now, count: 1 });
  } else {
    record.count += 1;
  }
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function normalizeEmail(email) {
  const s = String(email || '').trim().toLowerCase();
  if (!s) return '';
  const at = s.lastIndexOf('@');
  if (at === -1) return s;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  // Strip plus aliases for uniqueness checks.
  const plus = local.indexOf('+');
  const normalizedLocal = plus === -1 ? local : local.slice(0, plus);
  return `${normalizedLocal}@${domain}`;
}

const DISPOSABLE_DOMAINS = new Set([
  'tempmail.com', 'throwaway.com', 'mailinator.com', 'yopmail.com', 'guerrillamail.com',
  'sharklasers.com', 'getairmail.com', '10minutemail.com', 'burnermail.io', 'temp-mail.org',
]);

function isDisposableEmail(email) {
  const s = String(email || '').toLowerCase();
  const at = s.lastIndexOf('@');
  if (at === -1) return false;
  const domain = s.slice(at + 1);
  return DISPOSABLE_DOMAINS.has(domain) || domain.endsWith('.tempmail.com');
}

const COMMON_PASSWORDS = new Set([
  'password', 'password123', '123456', '12345678', '1234567890', 'qwerty', 'qwerty123',
  'letmein', 'welcome', 'welcome123', 'admin', 'admin123', 'blotter', 'blotterhost',
  'iloveyou', 'sunshine', 'princess', 'football', 'baseball', 'monkey', 'dragon',
  'trustno1', 'abc123', 'password1', 'login', 'master', 'hello123', 'changeme',
]);

function validatePassword(password) {
  const s = String(password);
  const lower = s.toLowerCase();
  const errors = [];
  if (s.length < MIN_PASSWORD_LENGTH) {
    errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(lower.replace(/[^a-z0-9]/g, ''))) {
    errors.push('That password is too common. Please choose a stronger one.');
  }
  return errors;
}

function validEmailShape(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

// ---------------------------------------------------------------------------
// Email verification tokens
// ---------------------------------------------------------------------------
function makeVerificationToken() {
  return base64url(crypto.randomBytes(32));
}

function makeVerificationLink(token, req) {
  const host = req.headers.host || ROOT_DOMAIN;
  return `https://${host}/verify-email?token=${encodeURIComponent(token)}`;
}

function logVerificationLink(email, link) {
  // No SMTP configured yet; emit the link so operators can verify in development
  // and so a future mailer worker can pick it up from structured logs.
  console.log(`[reader-auth] verification link for ${email}: ${link}`);
}

function sendVerification(user, req) {
  const token = makeVerificationToken();
  const expires = new Date(Date.now() + VERIFICATION_TTL_SECONDS * 1000).toISOString();
  const conn = db.db;
  conn.prepare(`
    UPDATE reader_users
       SET verification_token = ?,
           verification_token_expires_at = ?
     WHERE id = ?
  `).run(token, expires, user.id);

  const link = makeVerificationLink(token, req);
  logVerificationLink(user.email, link);
  return link;
}

function verifyEmailToken(token) {
  if (!token || typeof token !== 'string') return null;
  const conn = db.db;
  const user = conn.prepare(`
    SELECT id, email, verification_token_expires_at
      FROM reader_users
     WHERE verification_token = ?
  `).get(token);
  if (!user) return null;
  if (user.verification_token_expires_at && new Date(user.verification_token_expires_at) < new Date()) {
    return null;
  }
  conn.prepare(`
    UPDATE reader_users
       SET email_verified_at = datetime('now'),
           verification_token = NULL,
           verification_token_expires_at = NULL
     WHERE id = ?
  `).run(user.id);
  return user;
}

// ---------------------------------------------------------------------------
// Cross-state search SQL
// ---------------------------------------------------------------------------
//
// Schema (managed by migrations, not by this file):
//
//   CREATE TABLE blotters (
//     id           text PRIMARY KEY,
//     state_code   text NOT NULL,
//     title        text NOT NULL,
//     summary      text NOT NULL,
//     agency       text,
//     recorded_at  date NOT NULL
//     -- RLS policy: USING (state_code = current_setting('app.current_state_id', true)
//     --                  OR current_setting('app.current_state_id', true) = '*')
//   );
//   CREATE INDEX blotters_recorded_at_idx ON blotters (recorded_at DESC);
//   CREATE INDEX blotters_state_recorded_idx ON blotters (state_code, recorded_at DESC);
//
//   CREATE TABLE blotter_persons (
//     blotter_id   text NOT NULL REFERENCES blotters(id),
//     person_name  text NOT NULL
//   );
//   CREATE INDEX blotter_persons_name_idx ON blotter_persons (person_name);
//
// The query joins persons when the user supplied a free-text q, so the
// response can show *which names* matched (important for "trace a suspect
// across states" — the same name may not appear the same way in every blotter).
//
// All filters are guarded by IS NULL checks so the prepared statement can
// be reused for any combination of filters. The q parameter is a free-text term;
// we match against title, summary, and person_name. Postgres ILIKE with %term%
// is fine for low-cardinality searches; if the blotters table grows past
// a few million rows, swap to a trigram index (pg_trgm) — but that belongs
// in the schema, not here.

const CROSS_STATE_SEARCH_SQL = `
  SELECT
    b.id,
    b.state_code,
    b.title,
    b.summary,
    b.agency,
    b.recorded_at,
    COALESCE(
      (
        SELECT array_agg(DISTINCT bp.person_name)
        FROM blotter_persons bp
        WHERE bp.blotter_id = b.id
          AND ($1::text IS NULL OR bp.person_name ILIKE '%' || $1 || '%')
      ),
      ARRAY[]::text[]
    ) AS person_matches
  FROM blotters b
  WHERE
    ($1::text IS NULL OR (
      b.title   ILIKE '%' || $1 || '%' OR
      b.summary ILIKE '%' || $1 || '%' OR
      EXISTS (
        SELECT 1 FROM blotter_persons bp
        WHERE bp.blotter_id = b.id AND bp.person_name ILIKE '%' || $1 || '%'
      )
    ))
    AND ($2::text IS NULL OR b.state_code = $2)
    AND ($3::date IS NULL OR b.recorded_at >= $3)
    AND ($4::date IS NULL OR b.recorded_at <= $4)
  ORDER BY b.recorded_at DESC, b.id ASC
  LIMIT $5
`;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
const STATE_CODE_RE = stateRegistry.STATE_CODE_RE;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const MAX_QUERY_LEN = 200;

function clampLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, n);
}

function safeIsoDate(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (!ISO_DATE_RE.test(raw)) return null;
  const d = new Date(raw + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  if (d.toISOString().slice(0, 10) !== raw) return null;
  return raw;
}

function safeQueryText(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, MAX_QUERY_LEN);
  return trimmed.length > 0 ? trimmed : null;
}

function safeStateCode(raw) {
  if (typeof raw !== 'string') return null;
  const up = raw.toUpperCase();
  return STATE_CODE_RE.test(up) ? up : null;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------
function renderStateList(states) {
  if (!states.length) return '<li class="state-pill state-pill--empty">No states registered.</li>';
  return states.map((s) =>
    '<li class="state-pill">'
    + '<a class="state-pill__link" href="https://' + s.slug + '.' + ROOT_DOMAIN + '/">'
    + '<span class="state-pill__code">' + s.code + '</span>'
    + '<span class="state-pill__name">' + (s.name || s.slug) + '</span>'
    + '</a></li>'
  ).join('');
}

function renderStateCards(states) {
  if (!states.length) {
    return '<div class="landing-grid__empty">No states registered yet.</div>';
  }
  return states.slice(0, 8).map((s) => {
    const host = `${s.slug}.${ROOT_DOMAIN}`;
    return [
      '<article class="state-card">',
      '  <p class="state-card__code">' + s.code + '</p>',
      '  <h3 class="state-card__title">' + s.name + '</h3>',
      '  <p class="state-card__text">Read the latest public safety summaries for ' + s.name + '.</p>',
      '  <div class="state-card__actions">',
      '    <a class="state-card__button" href="https://' + host + '/">View news</a>',
      '    <a class="state-card__button state-card__button--ghost" href="/subscribe?state=' + encodeURIComponent(s.slug) + '">Subscribe</a>',
      '  </div>',
      '</article>',
    ].join('');
  }).join('');
}

function renderStateOptions(states) {
  if (!states.length) {
    return '<option value="">No states available</option>';
  }
  return states.map((s) =>
    '<option value="' + s.slug + '">' + s.name + '</option>'
  ).join('');
}

function renderNoticeFromQuery(query) {
  if (!query) return '';
  const state = String(query.state || '').trim();
  if (query.subscribed) {
    return [
      '<section class="notice notice--success">',
      '  <strong>Subscription requested.</strong>',
      state ? ' Updates for <strong>' + state + '</strong> will be routed when the subscription backend is enabled.' : ' We received your request and will route it when the subscription backend is enabled.',
      '</section>',
    ].join('');
  }
  if (query.error === 'email') {
    return [
      '<section class="notice notice--error">',
      '  <strong>Subscription failed.</strong> Please provide a valid email address and try again.',
      '</section>',
    ].join('');
  }
  return '';
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const states = stateRegistry.listAll();
    const html = render('root/landing.html', {
      REQUEST_HOST: req.headers.host,
      REQUEST_PATH: req.path,
      STATE_LIST_HTML: renderStateList(states),
      STATE_CARDS_HTML: renderStateCards(states),
      STATE_OPTIONS_HTML: renderStateOptions(states),
      ACTIVE_STATE_COUNT: states.length,
      NOTICE_HTML: renderNoticeFromQuery(req.query),
    });
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

router.get('/api/states', (_req, res) => {
  const states = stateRegistry.listAll().map((s) => ({
    code: s.code,
    slug: s.slug,
    name: s.name,
    host: `${s.slug}.${ROOT_DOMAIN}`,
    accent: (s.public && s.public.accent) || null,
  }));
  res.json({ ok: true, count: states.length, states });
});

router.get('/api/cross-state-search', async (req, res, next) => {
  try {
    const q = safeQueryText(req.query.q);
    const stateCode = safeStateCode(req.query.state_code);
    if (req.query.state_code && !stateCode) {
      return res.status(400).json({ ok: false, error: 'invalid state_code' });
    }
    const dateFrom = safeIsoDate(req.query.date_from);
    if (req.query.date_from && !dateFrom) {
      return res.status(400).json({ ok: false, error: 'invalid date_from (expected YYYY-MM-DD)' });
    }
    const dateTo = safeIsoDate(req.query.date_to);
    if (req.query.date_to && !dateTo) {
      return res.status(400).json({ ok: false, error: 'invalid date_to (expected YYYY-MM-DD)' });
    }
    if (dateFrom && dateTo && dateFrom > dateTo) {
      return res.status(400).json({ ok: false, error: 'date_from must be <= date_to' });
    }
    const limit = clampLimit(req.query.limit);

    const params = [q, stateCode, dateFrom, dateTo, limit];

    const result = await db.adminQuery(CROSS_STATE_SEARCH_SQL, params);
    if (!result.ok) {
      return res.status(503).json({
        ok: false,
        error: 'data plane unavailable',
        detail: result.error,
      });
    }

    const rows = result.rows.map((r) => {
      const t = stateRegistry.getByCode(r.state_code);
      return {
        id: r.id,
        state_code: r.state_code,
        state_name: t ? t.name : null,
        state_host: t ? `${t.slug}.${ROOT_DOMAIN}` : null,
        title: r.title,
        summary: r.summary,
        agency: r.agency,
        recorded_at: r.recorded_at instanceof Date
          ? r.recorded_at.toISOString().slice(0, 10)
          : r.recorded_at,
        person_matches: r.person_matches || [],
        url: t ? `https://${t.slug}.${ROOT_DOMAIN}/blotter/${r.id}` : null,
      };
    });

    res.json({
      ok: true,
      query: { q, state_code: stateCode, date_from: dateFrom, date_to: dateTo, limit },
      result_count: rows.length,
      active_state_count: stateRegistry.listAll().length,
      results: rows,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/login', (_req, res) => {
  const states = stateRegistry.listAll();
  const queryState = String(_req.query.state || '').trim();
  const notice = String(_req.query.notice || '').trim();
  const html = render('root/auth.html', {
    REQUEST_HOST: _req.headers.host,
    REQUEST_PATH: _req.path,
    AUTH_TITLE: 'Login',
    AUTH_MODE: 'login',
    AUTH_ACTION: queryState ? '/login?state=' + encodeURIComponent(queryState) : '/login',
    AUTH_HINT: 'Sign in to save states, follow feeds, and keep your subscriptions in sync.',
    ALT_LINK: '/register',
    ALT_TEXT: 'Need an account? Register instead.',
    STATE_REQUIRED: false,
    STATE_VALUE: queryState,
    NOTICE_HTML: renderAuthNotice(notice),
    HONEYPOT_NAME: '',
    STATE_LIST_HTML: renderStateList(states),
    STATE_CARDS_HTML: renderStateCards(states),
    STATE_OPTIONS_HTML: renderStateOptions(states),
    ACTIVE_STATE_COUNT: states.length,
  });
  res.type('html').send(html);
});

router.post('/login', async (req, res, next) => {
  try {
    ensureReaderUsersTable();
    const ip = clientIp(req);
    if (isRateLimited(ip, 'login')) {
      return res.status(429).type('html').send(renderReaderLoginError('Too many attempts. Please try again in 15 minutes.', ''));
    }

    const email = String(req.body && req.body.email || '').trim();
    const password = String(req.body && req.body.password || '');
    const state = String(req.body && req.body.state || '').trim();
    if (!email || !password) {
      recordAttempt(ip, 'login');
      return res.status(400).type('html').send(renderReaderLoginError('Email and password are required.', state));
    }

    const normalized = normalizeEmail(email);
    const conn = db.db;
    const user = conn.prepare('SELECT id, email, password_hash, email_verified_at FROM reader_users WHERE normalized_email = ?').get(normalized);
    if (!user) {
      recordAttempt(ip, 'login');
      return res.status(401).type('html').send(renderReaderLoginError('No account with that email.', state));
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      recordAttempt(ip, 'login');
      return res.status(401).type('html').send(renderReaderLoginError('Invalid credentials.', state));
    }

    if (!user.email_verified_at) {
      sendVerification(user, req);
      return res.status(403).type('html').send(renderReaderLoginError(
        'Please verify your email before logging in. A new verification link has been logged.',
        state,
        'Check your inbox (or server logs) for the verification link.'
      ));
    }

    recordAttempt(ip, 'login-success');
    const cookie = makeReaderCookie(user.email);
    const target = state ? '/' + state : '/';
    res.setHeader('Set-Cookie', cookie);
    res.redirect(303, target);
  } catch (err) {
    next(err);
  }
});

router.get('/register', (_req, res) => {
  const states = stateRegistry.listAll();
  const notice = String(_req.query.notice || '').trim();
  const html = render('root/auth.html', {
    REQUEST_HOST: _req.headers.host,
    REQUEST_PATH: _req.path,
    AUTH_TITLE: 'Register',
    AUTH_MODE: 'register',
    AUTH_ACTION: '/register',
    AUTH_HINT: 'Create a reader profile so you can follow states and save subscriptions.',
    ALT_LINK: '/login',
    ALT_TEXT: 'Already have an account? Login instead.',
    STATE_REQUIRED: false,
    STATE_VALUE: '',
    NOTICE_HTML: renderAuthNotice(notice),
    HONEYPOT_NAME: 'website',
    STATE_LIST_HTML: renderStateList(states),
    STATE_CARDS_HTML: renderStateCards(states),
    STATE_OPTIONS_HTML: renderStateOptions(states),
    ACTIVE_STATE_COUNT: states.length,
  });
  res.type('html').send(html);
});

router.post('/register', async (req, res, next) => {
  try {
    ensureReaderUsersTable();
    const ip = clientIp(req);
    if (isRateLimited(ip, 'register')) {
      return res.status(429).type('html').send(renderReaderLoginError('Too many registration attempts. Please try again in 15 minutes.', ''));
    }

    // Honeypot: invisible field that bots fill out.
    if (req.body && (req.body.website || req.body.url || req.body.company)) {
      return res.status(400).type('html').send(renderReaderLoginError('Registration rejected.', ''));
    }

    const email = String(req.body && req.body.email || '').trim();
    const password = String(req.body && req.body.password || '');
    const state = String(req.body && req.body.state || '').trim();
    if (!email || !password) {
      recordAttempt(ip, 'register');
      return res.status(400).type('html').send(renderReaderLoginError('Email and password are required.', state));
    }
    if (!validEmailShape(email)) {
      recordAttempt(ip, 'register');
      return res.status(400).type('html').send(renderReaderLoginError('Please enter a valid email address.', state));
    }
    if (isDisposableEmail(email)) {
      recordAttempt(ip, 'register');
      return res.status(400).type('html').send(renderReaderLoginError('Disposable email addresses are not allowed.', state));
    }

    const passwordErrors = validatePassword(password);
    if (passwordErrors.length) {
      recordAttempt(ip, 'register');
      return res.status(400).type('html').send(renderReaderLoginError(passwordErrors.join(' '), state));
    }

    const normalized = normalizeEmail(email);
    const passwordHash = bcrypt.hashSync(password, BCRYPT_COST);
    const conn = db.db;
    let user;
    try {
      const result = conn.prepare(`
        INSERT INTO reader_users (email, normalized_email, password_hash, state_slug)
        VALUES (?, ?, ?, ?)
      `).run(email, normalized, passwordHash, state || null);
      user = { id: result.lastInsertRowid, email, normalized_email: normalized, state_slug: state || null };
    } catch (err) {
      if (String(err.message).toLowerCase().includes('unique')) {
        recordAttempt(ip, 'register');
        return res.status(409).type('html').send(renderReaderLoginError('That email is already registered. Try logging in instead.', state));
      }
      throw err;
    }

    sendVerification(user, req);
    recordAttempt(ip, 'register-success');
    return res.redirect(303, '/register?notice=verify_email');
  } catch (err) {
    next(err);
  }
});

router.get('/verify-email', (req, res) => {
  try {
    ensureReaderUsersTable();
    const token = String(req.query.token || '').trim();
    const user = verifyEmailToken(token);
    if (!user) {
      return res.status(400).type('html').send(renderVerifyPage('That verification link is invalid or has expired.', false));
    }
    const cookie = makeReaderCookie(user.email);
    res.setHeader('Set-Cookie', cookie);
    return res.status(200).type('html').send(renderVerifyPage('Your email is verified and you are now signed in.', true));
  } catch (err) {
    res.status(500).type('html').send(renderVerifyPage('Something went wrong. Please try again.', false));
  }
});

router.get('/me', requireReader, (req, res) => {
  const states = stateRegistry.listAll();
  const alerts = listReaderAlerts(req.reader.id);
  const html = render('root/me.html', {
    REQUEST_HOST: req.headers.host,
    REQUEST_PATH: req.path,
    READER_EMAIL: req.reader.email,
    READER_STATE: req.reader.state_slug || '',
    ALERTS_HTML: renderAlertsListHtml(alerts),
    STATE_OPTIONS_HTML: renderStateOptions(states),
    ACTIVE_STATE_COUNT: states.length,
  });
  res.type('html').send(html);
});

router.get('/me/alerts', requireReader, (req, res) => {
  const states = stateRegistry.listAll();
  const alerts = listReaderAlerts(req.reader.id);
  const notice = String(req.query.notice || '').trim();
  const html = render('root/me-alerts.html', {
    REQUEST_HOST: req.headers.host,
    REQUEST_PATH: req.path,
    READER_EMAIL: req.reader.email,
    NOTICE_HTML: renderAlertNotice(notice),
    ALERTS_ROWS_HTML: renderAlertsRowsHtml(alerts),
    STATE_OPTIONS_HTML: renderStateOptions(states),
    ACTIVE_STATE_COUNT: states.length,
  });
  res.type('html').send(html);
});

router.post('/me/alerts', requireReader, express.urlencoded({ extended: false, limit: '8kb' }), (req, res) => {
  try {
    const alertType = String(req.body.alert_type || '').trim().toLowerCase();
    const target = String(req.body.target || '').trim();
    const frequency = String(req.body.frequency || '').trim().toLowerCase();
    if (!['county', 'keyword'].includes(alertType)) {
      return res.redirect(303, '/me/alerts?notice=invalid_type');
    }
    if (!target) {
      return res.redirect(303, '/me/alerts?notice=missing_target');
    }
    if (countReaderAlerts(req.reader.id) >= 10) {
      return res.redirect(303, '/me/alerts?notice=limit_reached');
    }
    const normalizedTarget = alertType === 'keyword' ? normalizeKeyword(target) : slugifyCounty(target);
    if (!normalizedTarget) {
      return res.redirect(303, '/me/alerts?notice=invalid_target');
    }
    createReaderAlert(req.reader.id, alertType, normalizedTarget, frequency);
    return res.redirect(303, '/me/alerts?notice=created');
  } catch (err) {
    console.error('[reader-alerts] create failed', err);
    return res.redirect(303, '/me/alerts?notice=error');
  }
});

router.post('/me/alerts/:id/delete', requireReader, (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (Number.isInteger(id) && id > 0) {
      deleteReaderAlert(req.reader.id, id);
    }
    return res.redirect(303, '/me/alerts?notice=deleted');
  } catch (err) {
    console.error('[reader-alerts] delete failed', err);
    return res.redirect(303, '/me/alerts?notice=error');
  }
});

router.get('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', clearReaderCookie());
  res.redirect(303, '/');
});

router.get('/network', (req, res) => {
  const states = stateRegistry.listAll();
  const html = render('root/network.html', {
    REQUEST_HOST: req.headers.host,
    REQUEST_PATH: '/network',
    STATE_LIST_HTML: renderStateList(states),
    STATE_CARDS_HTML: renderStateCards(states),
    STATE_OPTIONS_HTML: renderStateOptions(states),
    ACTIVE_STATE_COUNT: states.length,
  });
  res.type('html').send(html);
});

router.post('/api/subscribe', express.urlencoded({ extended: false, limit: '8kb' }), (req, res) => {
  const email = String(req.body && req.body.email || '').trim();
  const state = String(req.body && req.body.state || req.body.slug || '').trim();
  if (!email) {
    return res.redirect(303, '/subscribe?error=email');
  }
  try {
    const conn = require('../db').db;
    const createSql = `CREATE TABLE IF NOT EXISTS subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, state_slug TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`;
    conn.prepare(createSql).run();
    conn.prepare('INSERT OR IGNORE INTO subscriptions (email, state_slug) VALUES (?, ?)').run(email, state || null);
  } catch (_err) {
    console.error('subscribe failed', _err);
  }
  return res.redirect(303, '/subscribe?subscribed=1' + (state ? '&state=' + encodeURIComponent(state) : ''));
});

router.get('/subscribe', (req, res) => {
  const states = stateRegistry.listAll();
  const html = render('root/subscribe.html', {
    REQUEST_HOST: req.headers.host,
    REQUEST_PATH: req.path,
    STATE_OPTIONS_HTML: renderStateOptions(states),
    NOTICE_HTML: renderNoticeFromQuery(req.query),
  });
  res.type('html').send(html);
});

router.get('/about', (req, res) => {
  const html = render('root/about.html', {
    REQUEST_HOST: req.headers.host,
    REQUEST_PATH: req.path,
    ACTIVE_STATE_COUNT: stateRegistry.listAll().length,
  });
  res.type('html').send(html);
});

router.get('/methodology', (req, res) => {
  const html = render('root/methodology.html', {
    REQUEST_HOST: req.headers.host,
    REQUEST_PATH: req.path,
  });
  res.type('html').send(html);
});

router.get('/corrections', (req, res) => {
  const html = render('root/corrections.html', {
    REQUEST_HOST: req.headers.host,
    REQUEST_PATH: req.path,
  });
  res.type('html').send(html);
});

router.get('/healthz', async (_req, res) => {
  const dbh = await pg.healthCheck();
  res.json({
    ok: true,
    surface: 'root',
    network: {
      registered_states: stateRegistry.listAll().length,
      registered_codes: stateRegistry.listCodes(),
    },
    db: dbh,
  });
});

// ---------------------------------------------------------------------------
// Auth form helpers
// ---------------------------------------------------------------------------
function renderAuthNotice(notice) {
  if (notice === 'verify_email') {
    return [
      '<section class="notice notice--success">',
      '  <strong>Almost done.</strong> Check your email for a verification link.',
      '  (Until SMTP is configured, the link is also printed in the server logs.)',
      '</section>',
    ].join('\n');
  }
  if (notice === 'verified') {
    return [
      '<section class="notice notice--success">',
      '  <strong>Email verified.</strong> You can now sign in.',
      '</section>',
    ].join('\n');
  }
  return '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderVerifyPage(message, success) {
  return render('root/verify.html', {
    PAGE_TITLE: success ? 'Email verified' : 'Verification failed',
    REQUEST_HOST: '',
    REQUEST_PATH: '/verify-email',
    VERIFY_SUCCESS: success ? 'true' : '',
    VERIFY_MESSAGE: escapeHtml(message),
  });
}

function renderAlertNotice(notice) {
  const messages = {
    created: ['Alert created.', 'You will receive a digest when matching reports are published.'],
    deleted: ['Alert removed.', 'You will no longer receive updates for this target.'],
    limit_reached: ['Alert limit reached.', 'You can have up to 10 alerts. Remove one to add another.'],
    missing_target: ['Target missing.', 'Please enter a county or keyword.'],
    invalid_target: ['Invalid target.', 'Please check the county or keyword and try again.'],
    invalid_type: ['Invalid alert type.', 'Choose county or keyword.'],
    error: ['Something went wrong.', 'Please try again.'],
  };
  const m = messages[notice];
  if (!m) return '';
  return `<section class="notice notice--success"><strong>${m[0]}</strong> ${m[1]}</section>`;
}

function renderAlertsRowsHtml(alerts) {
  if (!alerts.length) {
    return '<tr><td colspan="4" class="board-table__loading">No alerts yet. Add one above.</td></tr>';
  }
  return alerts.map((a) => {
    const typeLabel = a.alert_type === 'county' ? 'County' : 'Keyword';
    const targetLabel = a.alert_type === 'county' ? titleizeCounty(a.target) + ' County' : escapeHtml(a.target);
    const freqLabel = a.frequency === 'weekly' ? 'Weekly' : 'Daily';
    return `<tr>
      <td>${typeLabel}</td>
      <td><strong>${targetLabel}</strong></td>
      <td>${freqLabel}</td>
      <td class="actions-col">
        <form method="post" action="/me/alerts/${a.id}/delete" style="display:inline;">
          <button type="submit" class="btn btn--danger btn--small">Remove</button>
        </form>
      </td>
    </tr>`;
  }).join('');
}

function renderAlertsListHtml(alerts) {
  if (!alerts.length) return '<p class="landing-panel__note">No alerts yet. <a href="/me/alerts">Create one</a>.</p>';
  return '<ul class="alert-list">' + alerts.map((a) => {
    const targetLabel = a.alert_type === 'county' ? titleizeCounty(a.target) + ' County' : escapeHtml(a.target);
    return `<li class="alert-list__item"><span class="alert-list__type">${a.alert_type}</span> ${targetLabel} <span class="alert-list__freq">${a.frequency}</span></li>`;
  }).join('') + '</ul>';
}

function renderReaderLoginError(message, state, detail) {
  ensureReaderUsersTable();
  const states = stateRegistry.listAll();
  return render('root/auth.html', {
    REQUEST_HOST: '',
    REQUEST_PATH: '/login',
    AUTH_TITLE: state ? 'Login • ' + state.toUpperCase() : 'Login',
    AUTH_MODE: 'login',
    AUTH_ACTION: state ? '/login?state=' + encodeURIComponent(state) : '/login',
    AUTH_HINT: message,
    ALT_LINK: '/register',
    ALT_TEXT: 'Need an account? Register instead.',
    STATE_REQUIRED: false,
    STATE_VALUE: state || '',
    NOTICE_HTML: detail ? `<section class="notice notice--warn"><strong>Verification required.</strong> ${escapeHtml(detail)}</section>` : '',
    HONEYPOT_NAME: '',
    STATE_LIST_HTML: renderStateList(states),
    STATE_CARDS_HTML: renderStateCards(states),
    STATE_OPTIONS_HTML: renderStateOptions(states),
    ACTIVE_STATE_COUNT: states.length,
  });
}

module.exports = router;
