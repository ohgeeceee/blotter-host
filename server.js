'use strict';

const path = require('path');
require('./src/lib/load-env').loadEnvFile(path.join(__dirname, '.env'));

const express = require('express');
const {
  subdomainMiddleware,
  ROOT_DOMAIN,
  isAdminHost,
} = require('./src/middleware/subdomain');
const rootRouter = require('./src/routes/root');
const adminRouter = require('./src/routes/admin');
const tenantRouter = require('./src/routes/state-public');
const { startCron } = require('./src/cron');
const { render: renderTemplate } = require('./src/render/template');
const pg = require('./src/db/pg');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';

app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// Tenant-surface assets (the public-facing site at <state>.blotter.host)
// reference /css/ and /js/ directly, so we also mount public/ at the root.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

// Lightweight request id (no deps)
app.use((req, _res, next) => {
  req.id =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  next();
});

// Tiny access log
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        id: req.id,
        host: req.headers.host,
        sub: req.subdomain,
        main: req.isMainDomain || false,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms,
      })
    );
  });
  next();
});

// Internal admin fleet proxy bypass
// When nginx proxies /admin/fleet -> blotter-host, it sets this header
// so the hostname check is skipped and admin routes work.
app.use((req, res, next) => {
  if (req.headers['x-internal-admin-bypass'] === '1') {
    // Spoof the Host header so subdomainMiddleware treats this as the admin host.
    req.headers.host = 'admin.blotter.host';
    // Rewrite /admin/fleet/* -> /admin/* so route matching works
    if (req.path.startsWith('/admin/fleet')) {
      req.adminProxyPrefix = '/admin/fleet';
      req.url = '/admin' + req.url.slice('/admin/fleet'.length);
    }
  }
  next();
});

// Host parsing — runs before any router
app.use(subdomainMiddleware);

// Basic host-aware test routes
app.get('/__root-test', (req, res, next) => {
  if (!req.state || !req.state.isRootDomain) {
    return next();
  }
  return res.status(200).send('Welcome to blotter.host');
});

app.get('/__tenant-test', (req, res, next) => {
  if (!req.state || req.state.isRootDomain) {
    return next();
  }
  const label = req.state.name
    ? req.state.name.charAt(0).toUpperCase() + req.state.name.slice(1)
    : 'State';
  return res.status(200).send(`Welcome to the ${label} blotter`);
});

// Public chat assistant (available on apex + tenant surfaces)
app.use('/api/chat', require('./src/routes/chat'));

// The administration portal is exposed only on the exact apex Host header.
app.use('/admin', (req, res, next) => {
  if (!isAdminHost(req)) {
    return res.status(404).send('Not Found');
  }
  return adminRouter(req, res, next);
});

// Policy: choose a router based on the parsed host.
// The tenant surface is the state-public pipeline so there is only one
// public state router in the live path.
app.use((req, res, next) => {
  if (req.isAdminHost) {
    return res.redirect(302, '/admin');
  }
  if (req.isMainDomain) {
    return rootRouter(req, res, next);
  }
  return tenantRouter(req, res, next);
});

// 404 fallback — render a standalone HTML page so browsers don't get JSON.
// If the template render itself fails, fall back to a hardcoded string so
// we never return JSON from a 404.
app.use((req, res) => {
  res.status(404);
  try {
    const html = renderTemplate('errors/404.html', {
      REQUEST_HOST: req.headers.host || '',
      REQUEST_PATH: req.path || '/',
    });
    return res.type('html').send(html);
  } catch (err) {
    console.error('404 template render failed', err);
    return res
      .type('html')
      .send(
        '<!doctype html><meta charset="utf-8"><title>Not Found</title>' +
        '<p style="font:16px system-ui;max-width:38rem;margin:4rem auto;">' +
        '404 — page not found.</p>'
      );
  }
});

// Error guard — render a standalone HTML page. We must never echo the error
// message or stack to the client. If the renderer itself fails, fall back
// to a hardcoded string.
app.use((err, req, res, _next) => {
  console.error('unhandled', err);
  res.status(500);
  try {
    const html = renderTemplate('errors/500.html', {});
    return res.type('html').send(html);
  } catch (renderErr) {
    console.error('500 template render failed', renderErr);
    return res
      .type('html')
      .send(
        '<!doctype html><meta charset="utf-8"><title>Error</title>' +
        '<p style="font:16px system-ui;max-width:38rem;margin:4rem auto;">' +
        '500 — internal server error.</p>'
      );
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(
    `[blotter-host] listening on 127.0.0.1:${PORT} (root=${ROOT_DOMAIN}, env=${NODE_ENV})`
  );
  // Idempotent schema bootstrap. Creates raw_records, generated_articles, and
  // their indexes on first run; no-op once the tables exist. Admin routes
  // also call this lazily, but public pages need generated_articles to exist
  // before the first request hits, so we kick it off here.
  pg.initializeDatabase().catch((err) => {
    console.error('[startup] pg.initializeDatabase failed:', err.message);
  });
});

if (process.env.DISABLE_CRON !== '1') {
  startCron({
    log: console,
  });
}
