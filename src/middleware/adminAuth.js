'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');

const COOKIE_NAME = 'blotter_admin';
const COOKIE_TTL_SECONDS = 60 * 60 * 8;

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

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(a || '');
  const right = Buffer.from(b || '');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function makeToken(secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const payload = base64url(
    JSON.stringify({
      sub: 'admin',
      exp: nowSeconds + COOKIE_TTL_SECONDS,
    })
  );
  return `${payload}.${sign(payload, secret)}`;
}

function verifyToken(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return false;

  const [payload, signature] = parts;
  if (!safeEqual(signature, sign(payload, secret))) return false;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims.sub === 'admin' && Number.isInteger(claims.exp) && claims.exp > nowSeconds;
  } catch (_err) {
    return false;
  }
}

function isProduction() {
  return (process.env.NODE_ENV || 'production') === 'production';
}

function cookieOptions() {
  const flags = [
    'Path=/admin',
    `Max-Age=${COOKIE_TTL_SECONDS}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (isProduction()) flags.push('Secure');
  return flags.join('; ');
}

function clearCookie() {
  const flags = ['Path=/admin', 'Max-Age=0', 'HttpOnly', 'SameSite=Strict'];
  if (isProduction()) flags.push('Secure');
  return `${COOKIE_NAME}=; ${flags.join('; ')}`;
}

function requireAdminConfig() {
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;
  const cookieSecret = process.env.ADMIN_COOKIE_SECRET;

  if (!passwordHash || !cookieSecret) {
    throw new Error('ADMIN_PASSWORD_HASH and ADMIN_COOKIE_SECRET must be set before enabling /admin');
  }

  return { passwordHash, cookieSecret };
}

function renderLogin(error) {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Admin</title>',
    '<style>',
    'body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f8;color:#101418}',
    'form{display:grid;gap:12px;width:min(320px,calc(100vw - 32px))}',
    'input,button{font:inherit;padding:10px 12px;border:1px solid #c9ced6;border-radius:6px}',
    'button{background:#101418;color:white;border-color:#101418;cursor:pointer}',
    'p{margin:0;color:#9b1c1c;font-size:14px}',
    '</style>',
    '</head>',
    '<body>',
    '<form method="post" action="/admin/login">',
    '<input type="password" name="password" autocomplete="current-password" autofocus required>',
    error ? '<p>Invalid password.</p>' : '',
    '<button type="submit">Sign in</button>',
    '</form>',
    '</body>',
    '</html>',
  ].join('');
}

function createAdminAuthMiddleware() {
  return function adminAuth(req, res, next) {
    let cookieSecret;
    try {
      cookieSecret = requireAdminConfig().cookieSecret;
    } catch (err) {
      return next(err);
    }

    const cookies = parseCookies(req.headers.cookie);
    if (verifyToken(cookies[COOKIE_NAME], cookieSecret)) {
      return next();
    }

    res.status(401).type('html').send(renderLogin(false));
  };
}

async function handleAdminLogin(req, res) {
  const { passwordHash, cookieSecret } = requireAdminConfig();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const ok = await bcrypt.compare(password, passwordHash);

  if (!ok) {
    res.status(401).type('html').send(renderLogin(true));
    return;
  }

  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${makeToken(cookieSecret)}; ${cookieOptions()}`);
  res.redirect(303, '/admin');
}

function handleAdminLogout(_req, res) {
  res.setHeader('Set-Cookie', clearCookie());
  res.redirect(303, '/admin');
}

module.exports = {
  COOKIE_NAME,
  createAdminAuthMiddleware,
  handleAdminLogin,
  handleAdminLogout,
  makeToken,
  verifyToken,
};
