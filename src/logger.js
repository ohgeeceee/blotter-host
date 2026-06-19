'use strict';

const { db } = require('./db');

const VALID_SEVERITY = new Set(['debug', 'info', 'warn', 'error']);

const insertStmt = db.prepare(`
  INSERT INTO scraper_logs (ts, tenant_slug, severity, source, run_id, message)
  VALUES (@ts, @tenant_slug, @severity, @source, @run_id, @message)
`);

function log({ tenant = null, severity = 'info', source = 'scraper', runId = null, message }) {
  const sev = VALID_SEVERITY.has(severity) ? severity : 'info';
  const text = typeof message === 'string'
    ? message
    : (() => { try { return JSON.stringify(message); } catch (_e) { return String(message); } })();
  insertStmt.run({
    ts: new Date().toISOString(),
    tenant_slug: tenant,
    severity: sev,
    source: String(source).slice(0, 64),
    run_id: runId,
    message: text.slice(0, 8192),
  });
}

const tailStmt = db.prepare(`
  SELECT id, ts, tenant_slug, severity, source, run_id, message
  FROM scraper_logs
  WHERE id > ?
  ORDER BY id ASC
  LIMIT ?
`);

const recentStmt = db.prepare(`
  SELECT id, ts, tenant_slug, severity, source, run_id, message
  FROM scraper_logs
  ORDER BY id DESC
  LIMIT ?
`);

const tenantRecentStmt = db.prepare(`
  SELECT id, ts, tenant_slug, severity, source, run_id, message
  FROM scraper_logs
  WHERE tenant_slug = ?
  ORDER BY id DESC
  LIMIT ?
`);

function tail({ sinceId = 0, limit = 200, tenant = null } = {}) {
  const cap = Math.max(1, Math.min(1000, Number(limit) || 200));
  if (tenant) return tenantRecentStmt.all(tenant, cap).reverse();
  const recent = recentStmt.all(cap);
  if (!Number.isFinite(sinceId) || sinceId <= 0) return recent.reverse();
  return tailStmt.all(sinceId, cap);
}

module.exports = { log, tail };
