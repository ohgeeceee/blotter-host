'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const tenants = require('../data/tenants');
const controlDb = require('../db/control');
const store = require('./store');
const runner = require('./runner');
const stream = require('./stream');
const settings = require('./settings');
const logger = require('../logger');

const router = express.Router();

const TENANTS_JSON_PATH = path.resolve(__dirname, '..', '..', 'tenants.json');

function loadOpsTenants() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(TENANTS_JSON_PATH, 'utf8'));
  } catch (err) {
    return { error: 'tenants.json unreadable: ' + err.message, tenants: [] };
  }
  const list = (parsed.tenants || []).map((t) => ({
    slug: String(t.slug || '').toLowerCase(),
    name: String(t.name || t.slug),
    host: `${t.slug}.blotter.host`,
    dbPath: t.dbPath || null,
    heartbeatPath: t.heartbeatPath || null,
    scraperCommand: t.scraperCommand || null,
    scraperCwd: t.scraperCwd || null,
    notes: t.notes || '',
  }));
  return { tenants: list };
}

function findTenant(slug) {
  return loadOpsTenants().tenants.find((t) => t.slug === String(slug).toLowerCase()) || null;
}

function requireXhr(req, res, next) {
  const xrw = req.headers['x-requested-with'];
  if (xrw && xrw.toLowerCase() === 'xmlhttprequest') return next();
  return res.status(403).json({ ok: false, error: 'X-Requested-With header required' });
}

function summarize() {
  const { tenants: opsTenants } = loadOpsTenants();
  const statusRows = new Map(store.listStatus().map((s) => [s.tenant_slug, s]));

  return opsTenants.map((t) => {
    const s = statusRows.get(t.slug) || null;
    return {
      slug: t.slug,
      name: t.name,
      host: t.host,
      paused: !!(s && s.paused),
      lastHeartbeat: s ? s.last_heartbeat : null,
      lastStatus: s ? s.last_status : null,
      lastMessage: s ? s.last_message : null,
      lastRunId: s ? s.last_run_id : null,
      hasCommand: !!t.scraperCommand,
      isRunning: runner.isRunning(t.slug),
    };
  });
}

router.get('/tenants', (_req, res) => {
  res.json({ ok: true, tenants: summarize() });
});

router.get('/settings', (_req, res) => {
  res.json({ ok: true, ...settings.buildSettingsResponse() });
});

router.post('/settings', requireXhr, (req, res) => {
  const updated = settings.saveSettings(req.body || {});
  res.json({ ok: true, settings: updated, readiness: settings.getReadiness(updated), states: settings.getStateLaunchRows(updated) });
});

router.get('/tenants/:slug', (req, res) => {
  const t = findTenant(req.params.slug);
  if (!t) return res.status(404).json({ ok: false, error: 'unknown tenant' });
  res.json({ ok: true, tenant: t, status: store.getStatus(t.slug) || null, running: runner.isRunning(t.slug) });
});

router.post('/tenants/:slug/scraper/run', requireXhr, (req, res) => {
  const t = findTenant(req.params.slug);
  if (!t) return res.status(404).json({ ok: false, error: 'unknown tenant' });

  if (!t.scraperCommand) {
    return res.status(409).json({ ok: false, error: 'tenant has no scraperCommand configured' });
  }

  const result = runner.trigger(t, { source: 'admin' });
  if (!result.ok) {
    const code = result.status === 'paused' || result.status === 'already-running' ? 409 : 400;
    return res.status(code).json({ ok: false, error: result.status, detail: result.error || null });
  }
  res.json({ ok: true, runId: result.runId });
});

router.post('/tenants/:slug/scraper/pause', requireXhr, (req, res) => {
  const t = findTenant(req.params.slug);
  if (!t) return res.status(404).json({ ok: false, error: 'unknown tenant' });

  const wantPaused = typeof req.body === 'object' && req.body !== null && req.body.paused === false ? false : true;
  const updated = store.setPaused(t.slug, wantPaused);

  logger.log({
    tenant: t.slug,
    severity: 'info',
    source: 'admin',
    message: `scraper ${wantPaused ? 'paused' : 'resumed'} via admin panel`,
  });

  res.json({ ok: true, paused: !!updated.paused });
});

router.get('/logs', (req, res) => {
  const since = parseInt(req.query.since, 10);
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
  const tenant = req.query.tenant || null;
  const rows = logger.tail({ sinceId: Number.isFinite(since) ? since : 0, limit, tenant });
  res.json({ ok: true, rows, latestId: rows.length ? rows[rows.length - 1].id : 0 });
});

router.get('/logs/stream', (req, res) => {
  stream.attach(req, res, { tenant: req.query.tenant || null });
});

router.get('/runs', (req, res) => {
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 25));
  res.json({ ok: true, runs: store.listAllRuns(limit) });
});

router.get('/healthz', (_req, res) => {
  res.json({ ok: true, sseClients: stream.clientCount(), tenants: tenants.TENANTS.length });
});

/* --------------------------------------------------------------------------
 * News sources
 * -------------------------------------------------------------------------- */

const VALID_SOURCE_TYPES = new Set(['rss', 'website']);
const VALID_STRATEGIES = new Set(['rssbulletin', 'staticbulletin', 'dynamicbulletin']);

function isValidUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_err) {
    return false;
  }
}

function getKnownTenantSlugs() {
  return new Set(loadOpsTenants().tenants.map((t) => String(t.slug || '').toLowerCase()));
}

function validateNewsSource(body, isUpdate = false) {
  const errors = [];
  const stateSlug = String(body.state_slug || '').toLowerCase().trim();
  const sourceName = String(body.source_name || '').trim();
  const sourceUrl = String(body.source_url || '').trim();
  const sourceType = String(body.source_type || 'rss').toLowerCase().trim();
  const strategy = String(body.strategy || 'rssBulletin').trim();

  if (!isUpdate || body.state_slug !== undefined) {
    if (!stateSlug) errors.push('state_slug is required');
    else if (!getKnownTenantSlugs().has(stateSlug)) errors.push(`unknown state_slug: ${stateSlug}`);
  }
  if (!isUpdate || body.source_name !== undefined) {
    if (!sourceName) errors.push('source_name is required');
    else if (sourceName.length > 200) errors.push('source_name must be <= 200 characters');
  }
  if (!isUpdate || body.source_url !== undefined) {
    if (!sourceUrl) errors.push('source_url is required');
    else if (!isValidUrl(sourceUrl)) errors.push('source_url must be a valid http(s) URL');
    else if (sourceUrl.length > 2048) errors.push('source_url must be <= 2048 characters');
  }
  if (body.source_type !== undefined && !VALID_SOURCE_TYPES.has(sourceType)) {
    errors.push('source_type must be rss or website');
  }
  const strategyLower = strategy.toLowerCase();
  if (body.strategy !== undefined && !VALID_STRATEGIES.has(strategyLower)) {
    errors.push('strategy must be rssBulletin, staticBulletin, or dynamicBulletin');
  }
  if (sourceType === 'rss' && strategyLower !== 'rssbulletin') {
    errors.push('rss sources must use the rssBulletin strategy');
  }
  if (sourceType === 'website' && strategyLower === 'rssbulletin') {
    errors.push('website sources cannot use the rssBulletin strategy');
  }
  if (body.priority !== undefined && (body.priority === '' || Number.isNaN(parseInt(body.priority, 10)))) {
    errors.push('priority must be an integer');
  }
  if (body.metadata_json !== undefined) {
    try {
      JSON.parse(String(body.metadata_json || '{}'));
    } catch (_err) {
      errors.push('metadata_json must be valid JSON');
    }
  }

  return errors;
}

function buildNewsSourcePayload(row) {
  let metadata = {};
  try {
    metadata = JSON.parse(row.metadata_json || '{}');
  } catch (_err) {
    metadata = {};
  }
  return {
    id: row.id,
    state_slug: row.state_slug,
    source_name: row.source_name,
    source_url: row.source_url,
    source_type: row.source_type,
    strategy: row.strategy,
    is_enabled: row.is_enabled,
    priority: row.priority,
    metadata,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

router.get('/news-sources', (req, res) => {
  controlDb.setup();
  const state = req.query.state || null;
  const rows = controlDb.listNewsSources(state);
  res.json({ ok: true, sources: rows.map(buildNewsSourcePayload) });
});

router.post('/news-sources', requireXhr, (req, res) => {
  controlDb.setup();
  const body = req.body || {};
  const errors = validateNewsSource(body, false);
  if (errors.length) {
    return res.status(400).json({ ok: false, error: errors.join('; ') });
  }

  const row = controlDb.createNewsSource({
    state_slug: body.state_slug,
    source_name: body.source_name,
    source_url: body.source_url,
    source_type: body.source_type,
    strategy: body.strategy,
    is_enabled: body.is_enabled,
    priority: body.priority,
    metadata_json: body.metadata_json ? String(body.metadata_json) : undefined,
  });

  logger.log({
    tenant: row.state_slug,
    severity: 'info',
    source: 'admin',
    message: `news source created: ${row.source_name} (${row.source_url})`,
  });

  res.status(201).json({ ok: true, source: buildNewsSourcePayload(row) });
});

router.get('/news-sources/:id', (req, res) => {
  controlDb.setup();
  const row = controlDb.getNewsSourceById(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'news source not found' });
  res.json({ ok: true, source: buildNewsSourcePayload(row) });
});

router.put('/news-sources/:id', requireXhr, (req, res) => {
  controlDb.setup();
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid id' });
  }
  const existing = controlDb.getNewsSourceById(id);
  if (!existing) return res.status(404).json({ ok: false, error: 'news source not found' });

  const body = req.body || {};
  const errors = validateNewsSource(body, true);
  if (errors.length) {
    return res.status(400).json({ ok: false, error: errors.join('; ') });
  }

  const row = controlDb.updateNewsSource(id, {
    state_slug: body.state_slug,
    source_name: body.source_name,
    source_url: body.source_url,
    source_type: body.source_type,
    strategy: body.strategy,
    is_enabled: body.is_enabled,
    priority: body.priority,
    metadata_json: body.metadata_json ? String(body.metadata_json) : undefined,
  });

  logger.log({
    tenant: row.state_slug,
    severity: 'info',
    source: 'admin',
    message: `news source updated: ${row.source_name} (${row.source_url})`,
  });

  res.json({ ok: true, source: buildNewsSourcePayload(row) });
});

router.delete('/news-sources/:id', requireXhr, (req, res) => {
  controlDb.setup();
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid id' });
  }
  const existing = controlDb.getNewsSourceById(id);
  if (!existing) return res.status(404).json({ ok: false, error: 'news source not found' });

  controlDb.deleteNewsSource(id);

  logger.log({
    tenant: existing.state_slug,
    severity: 'info',
    source: 'admin',
    message: `news source deleted: ${existing.source_name}`,
  });

  res.json({ ok: true, deleted: true });
});

router.post('/news-sources/run', requireXhr, async (req, res) => {
  try {
    const scheduler = require('../ingestion/scheduler');
    const stateSlug = req.body && req.body.state_slug ? String(req.body.state_slug).toLowerCase().trim() : null;
    const result = await scheduler.runNewsSources(stateSlug);

    logger.log({
      tenant: stateSlug || 'network',
      severity: 'info',
      source: 'admin',
      message: `news sources run complete: ${result.sourcesRun || 0} source(s)`,
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/news-sources/:id/test', requireXhr, async (req, res) => {
  controlDb.setup();
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid id' });
  }
  const existing = controlDb.getNewsSourceById(id);
  if (!existing) return res.status(404).json({ ok: false, error: 'news source not found' });

  try {
    const response = await fetch(existing.source_url, {
      method: 'GET',
      headers: { 'User-Agent': 'blotter.host news-source validator' },
      signal: AbortSignal.timeout(15000),
    });
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const body = await response.text();

    let isRss = false;
    if (existing.source_type === 'rss' || existing.strategy === 'rssBulletin') {
      isRss = contentType.includes('xml') || contentType.includes('rss') || contentType.includes('atom') ||
        /^\s*<[?]xml|<rss|<feed/i.test(body);
    }

    res.json({
      ok: true,
      status: response.status,
      content_type: contentType,
      body_length: body.length,
      looks_like_rss: isRss,
      reachable: response.ok,
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

module.exports = router;
