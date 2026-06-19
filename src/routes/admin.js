'use strict';

const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcrypt');
const { render } = require('../render/template');
const controlDb = require('../db/control');
const pg = require('../db/pg');
const { getNetworkStatus } = require('../data/tenants');
const controlApi = require('../control/api');

const router = express.Router();
const networkRouter = express.Router();
const COOKIE_NAME = 'blotter_control_session';
const OPS_COOKIE_NAME = 'blotter_ops_session';
const SESSION_TTL_SECONDS = 60 * 60 * 8;

function getOpsSessionSecret() {
  const secret = String(process.env.OPS_SESSION_SECRET || '').trim();
  if (!secret) {
    throw new Error('OPS_SESSION_SECRET is required');
  }
  return secret;
}

function b64urlDecode(value) {
  const pad = 4 - (value.length % 4);
  if (pad !== 4) value += '='.repeat(pad);
  return Buffer.from(value, 'base64url');
}

function verifyJwt(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  const sig = crypto.createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest('base64url');
  if (signatureB64 !== sig) return null;
  try {
    const payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    if (!Number.isInteger(payload.exp) || payload.exp <= nowSeconds) return null;
    return payload;
  } catch (_err) {
    return null;
  }
}

function opsCookieOptions(maxAgeSeconds = SESSION_TTL_SECONDS) {
  const flags = [
    'Path=/admin/fleet',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if ((process.env.NODE_ENV || 'production') === 'production') {
    flags.push('Secure');
  }
  return flags.join('; ');
}

function parseCookies(header) {
  return String(header || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const eq = part.indexOf('=');
      if (eq === -1) return cookies;
      cookies[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1));
      return cookies;
    }, {});
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function makeSessionPayload(username, nowSeconds = Math.floor(Date.now() / 1000)) {
  return Buffer.from(JSON.stringify({
    sub: username,
    exp: nowSeconds + SESSION_TTL_SECONDS,
  })).toString('base64url');
}

function verifySession(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return false;

  const [payload, sig] = parts;
  if (sign(payload, secret) !== sig) return false;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof claims.sub === 'string' && claims.sub && Number.isInteger(claims.exp) && claims.exp > nowSeconds;
  } catch (_err) {
    return false;
  }
}

function getCookieSecret() {
  const secret = String(process.env.ADMIN_COOKIE_SECRET || '').trim();
  if (!secret) {
    throw new Error('ADMIN_COOKIE_SECRET is required');
  }
  return secret;
}

function adminBasePath(req) {
  return req && req.adminProxyPrefix ? req.adminProxyPrefix : '/admin';
}

function cookieOptions(req, maxAgeSeconds = SESSION_TTL_SECONDS) {
  const path = `${adminBasePath(req)}/`;
  const flags = [
    `Path=${path}`,
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if ((process.env.NODE_ENV || 'production') === 'production') {
    flags.push('Secure');
  }
  return flags.join('; ');
}

function clearCookie(req) {
  const path = `${adminBasePath(req)}/`;
  return `${COOKIE_NAME}=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Strict${(process.env.NODE_ENV || 'production') === 'production' ? '; Secure' : ''}`;
}

function renderLogin(errorMessage = '', req = null) {
  return render('admin/login.html', {
    PAGE_TITLE: 'Admin Login',
    EXTRA_HEAD_HTML: '',
    ERROR_MESSAGE: errorMessage,
    LOGIN_PATH: `${adminBasePath(req)}/login`,
  });
}

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildDashboardRows(rows, req = null) {
  if (!rows.length) {
    return '<tr><td colspan="5" class="board-table__loading">No articles yet.</td></tr>';
  }

  const base = adminBasePath(req);
  return rows.map((row) => {
    const createdAt = row.created_at ? new Date(row.created_at).toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }) : 'Unknown';
    const status = String(row.publication_status || 'draft');
    const statusClass = status === 'published' ? 'published' : status === 'archived' ? 'archived' : 'draft';
    const statusLabel = status === 'published' ? 'Published' : status === 'archived' ? 'Unpublished' : 'Draft';
    const actions = [];
    if (status !== 'published') {
      actions.push(`<form method="post" action="${base}/articles/${encodeURIComponent(row.id)}/publish" style="display:inline;"><button type="submit" class="btn btn--primary btn--small">Publish</button></form>`);
    }
    if (status !== 'archived') {
      actions.push(`<form method="post" action="${base}/articles/${encodeURIComponent(row.id)}/unpublish" style="display:inline;"><button type="submit" class="btn btn--ghost btn--small">Hide</button></form>`);
    }
    return [
      '<tr>',
      `<td><span class="status-pill status-pill--${statusClass}"><span class="status-pill__dot"></span>${escapeHtml(statusLabel)}</span></td>`,
      `<td><strong class="article-row__state">${escapeHtml(row.state)}</strong></td>`,
      `<td class="article-row__headline">${escapeHtml(row.headline)}</td>`,
      `<td>${escapeHtml(createdAt)}</td>`,
      '<td class="actions-col">',
      actions.join(' '),
      '</td>',
      '</tr>',
    ].join('');
  }).join('');
}

function renderDashboard({ articles = [], notice = '', req = null } = {}) {
  const articleRows = buildDashboardRows(articles, req);
  const status = getNetworkStatus();
  const n = status.network;
  const now = new Date();
  return render('admin/index.html', {
    PAGE_TITLE: 'Control Panel — blotter.host',
    EXTRA_HEAD_HTML: '',
    PAGE_HEADING_HTML: '<h1 class="page-header__title">Control panel</h1>',
    LOGIN_FORM_HTML: '',
    FOOTER_NOTICE_HTML: notice ? `<p class="admin-notice">${escapeHtml(notice)}</p>` : '',
    ARTICLE_ROWS_HTML: articleRows,
    BODY_CLASS: 'page-dashboard',
    GENERATED_AT_ISO: now.toISOString(),
    GENERATED_AT_HUMAN: now.toUTCString(),
    TENANT_COUNT: n.tenantCount,
    ACTIVE_TENANT_COUNT: n.activeTenants,
  });
}

function renderNetwork() {
  const status = getNetworkStatus();
  const n = status.network;
  return render('admin/network.html', {
    PAGE_TITLE: 'Network — blotter.host',
    EXTRA_HEAD_HTML: '',
    BODY_CLASS: 'page-network',
    TENANT_COUNT: n.tenantCount,
    ACTIVE_TENANT_COUNT: n.activeTenants,
  });
}

function requireAdmin(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);

  // 1. Check legacy blotter-host session.
  try {
    const secret = getCookieSecret();
    if (verifySession(cookies[COOKIE_NAME], secret)) {
      return next();
    }
  } catch (err) {
    // If legacy secret is missing, fall through to ops session check.
  }

  // 2. Check shared ops session issued by Montana Blotter.
  try {
    const opsSecret = getOpsSessionSecret();
    const jwt = verifyJwt(cookies[OPS_COOKIE_NAME], opsSecret);
    if (jwt) {
      req.opsUser = { username: jwt.sub, role: jwt.role };
      return next();
    }
  } catch (err) {
    return next(err);
  }

  return res.status(401).type('html').send(renderLogin('', req));
}

router.use(express.urlencoded({ extended: false, limit: '8kb' }));
router.use(express.json({ limit: '16kb' }));

router.get('/login', (req, res) => {
  res.status(200).type('html').send(renderLogin('', req));
});

router.post('/login', async (req, res, next) => {
  try {
    controlDb.setup();
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) {
      return res.status(400).type('html').send(renderLogin('Username and password are required.', req));
    }

    const conn = controlDb.getDb();
    const user = conn.prepare(
      'SELECT id, username, password_hash, role, is_active FROM admin_users WHERE username = ?'
    ).get(username);

    if (!user || !user.is_active) {
      return res.status(401).type('html').send(renderLogin('Invalid credentials.', req));
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).type('html').send(renderLogin('Invalid credentials.', req));
    }

    const secret = getCookieSecret();
    const payload = makeSessionPayload(user.username);
    const signature = sign(payload, secret);
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${payload}.${signature}; ${cookieOptions(req)}`);
    return res.redirect(303, `${adminBasePath(req)}/`);
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearCookie(req));
  res.redirect(303, `${adminBasePath(req)}/login`);
});

router.get('/healthz', (_req, res) => {
  res.json({ ok: true, controlDbPath: controlDb.getDbPath() });
});

router.use(requireAdmin);

router.get('/api/metrics', (_req, res) => {
  res.json({ ok: true, ...getNetworkStatus() });
});

router.use('/api', controlApi);

router.get('/', (req, res) => {
  return res.redirect(303, `${adminBasePath(req)}/dashboard`);
});

router.get('/dashboard', async (req, res, next) => {
  try {
    await pg.initializeDatabase().catch(() => {});
    const result = await pg.adminQuery(
      `SELECT id, state, headline, publication_status, created_at
         FROM generated_articles
        ORDER BY created_at DESC
        LIMIT 25`
    );

    if (!result || result.ok === false) {
      return res.status(503).type('html').send(renderDashboard({
        articles: [],
        notice: 'Postgres is unavailable. Dashboard is read-only until the database recovers.',
        req,
      }));
    }

    const queryNotice = String(req.query.notice || '').trim();
    const notice = queryNotice ? queryNotice.replace(/\+/g, ' ') : '';
    return res.status(200).type('html').send(renderDashboard({ articles: result.rows, notice, req }));
  } catch (err) {
    return next(err);
  }
});

router.get('/network', async (req, res, next) => {
  try {
    return res.status(200).type('html').send(renderNetwork());
  } catch (err) {
    return next(err);
  }
});

router.get('/news-sources', async (req, res, next) => {
  try {
    controlDb.setup();
    const stateFilter = String(req.query.state || '').trim().toLowerCase();
    const rows = controlDb.listNewsSources(stateFilter || null);
    const tenantList = (await getNetworkStatus()).tenants || [];
    const sourcesHtml = rows.map((s) => {
      const enabledClass = s.is_enabled ? 'source-row--enabled' : 'source-row--disabled';
      return `<tr class="source-row ${enabledClass}" data-id="${s.id}">
        <td><strong class="source-row__name">${escapeHtml(s.source_name)}</strong></td>
        <td><span class="source-row__state">${escapeHtml(s.state_slug)}</span></td>
        <td><a href="${escapeAttr(s.source_url)}" target="_blank" rel="noopener">${escapeHtml(s.source_url)}</a></td>
        <td><code>${escapeHtml(s.source_type)}</code> / <code>${escapeHtml(s.strategy)}</code></td>
        <td>${s.is_enabled ? 'Enabled' : 'Disabled'}</td>
        <td class="actions-col">
          <button type="button" class="btn btn--ghost btn--small" data-action="test" data-id="${s.id}">Test</button>
          <button type="button" class="btn btn--ghost btn--small" data-action="edit" data-id="${s.id}">Edit</button>
          <button type="button" class="btn btn--danger btn--small" data-action="delete" data-id="${s.id}">Delete</button>
        </td>
      </tr>`;
    }).join('');

    const stateOptions = tenantList.map((t) => {
      const selected = stateFilter === t.slug ? ' selected' : '';
      return `<option value="${escapeAttr(t.slug)}"${selected}>${escapeHtml(t.name)}</option>`;
    }).join('');

    const html = render('admin/news-sources.html', {
      PAGE_TITLE: 'News Sources — blotter.host',
      EXTRA_HEAD_HTML: '',
      BODY_CLASS: 'page-news-sources',
      SOURCES_ROWS_HTML: sourcesHtml || '<tr><td colspan="6" class="board-table__loading">No news sources configured yet.</td></tr>',
      STATE_OPTIONS_HTML: `<option value="">All states</option>${stateOptions}`,
      CURRENT_FILTER: stateFilter,
    });
    return res.status(200).type('html').send(html);
  } catch (err) {
    return next(err);
  }
});

router.post('/articles/publish-all', async (req, res, next) => {
  try {
    await pg.initializeDatabase().catch(() => {});
    const result = await pg.adminQuery(
      `UPDATE generated_articles
          SET publication_status = 'published',
              published_at = COALESCE(published_at, NOW()),
              updated_at = NOW()
        WHERE publication_status = 'draft'
        RETURNING id`
    );

    if (!result || result.ok === false) {
      return res.status(503).type('html').send(renderDashboard({
        articles: [],
        notice: 'Unable to publish articles right now.',
        req,
      }));
    }

    const count = result.rowCount || 0;
    return res.redirect(303, `${adminBasePath(req)}/dashboard?notice=${encodeURIComponent(count + ' article' + (count === 1 ? '' : 's') + ' published')}`);
  } catch (err) {
    return next(err);
  }
});

router.post('/articles/:id/publish', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).type('html').send(renderDashboard({ notice: 'Invalid article id.', req }));
    }

    await pg.initializeDatabase().catch(() => {});
    const result = await pg.adminQuery(
      `UPDATE generated_articles
          SET publication_status = 'published',
              published_at = COALESCE(published_at, NOW()),
              updated_at = NOW()
        WHERE id = $1
        RETURNING id`,
      [id]
    );

    if (!result || result.ok === false) {
      return res.status(503).type('html').send(renderDashboard({
        articles: [],
        notice: 'Unable to update the article right now.',
        req,
      }));
    }

    return res.redirect(303, `${adminBasePath(req)}/dashboard?notice=Article+published`);
  } catch (err) {
    return next(err);
  }
});

router.post('/articles/:id/unpublish', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).type('html').send(renderDashboard({ notice: 'Invalid article id.', req }));
    }

    await pg.initializeDatabase().catch(() => {});
    const result = await pg.adminQuery(
      `UPDATE generated_articles
          SET publication_status = 'archived',
              published_at = NULL,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id`,
      [id]
    );

    if (!result || result.ok === false) {
      return res.status(503).type('html').send(renderDashboard({
        articles: [],
        notice: 'Unable to update the article right now.',
        req,
      }));
    }

    return res.redirect(303, `${adminBasePath(req)}/dashboard?notice=Article+hidden`);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
