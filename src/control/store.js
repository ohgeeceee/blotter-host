'use strict';

const { db } = require('../db');

const insertRun = db.prepare(`
  INSERT INTO scraper_runs (tenant_slug, run_id, started_at, status, message)
  VALUES (@tenant_slug, @run_id, @started_at, @status, @message)
`);

const finishRun = db.prepare(`
  UPDATE scraper_runs
  SET finished_at = @finished_at,
      status      = @status,
      records_added = @records_added,
      message     = @message
  WHERE run_id = @run_id
`);

const latestRunStmt = db.prepare(`
  SELECT id, tenant_slug, run_id, started_at, finished_at, status, records_added, message
  FROM scraper_runs
  WHERE tenant_slug = ?
  ORDER BY id DESC
  LIMIT 1
`);

const listRunsStmt = db.prepare(`
  SELECT id, tenant_slug, run_id, started_at, finished_at, status, records_added, message
  FROM scraper_runs
  ORDER BY id DESC
  LIMIT ?
`);

const getStatusStmt = db.prepare(`
  SELECT tenant_slug, paused, last_heartbeat, last_status, last_message, last_run_id, updated_at
  FROM scraper_status WHERE tenant_slug = ?
`);

const listStatusStmt = db.prepare(`
  SELECT tenant_slug, paused, last_heartbeat, last_status, last_message, last_run_id, updated_at
  FROM scraper_status ORDER BY tenant_slug
`);

const upsertStatusStmt = db.prepare(`
  INSERT INTO scraper_status (tenant_slug, paused, updated_at)
  VALUES (@tenant_slug, @paused, datetime('now'))
  ON CONFLICT(tenant_slug) DO UPDATE SET
    paused     = excluded.paused,
    updated_at = datetime('now')
`);

function startRun(tenantSlug, runId, message) {
  insertRun.run({
    tenant_slug: tenantSlug,
    run_id: runId,
    started_at: new Date().toISOString(),
    status: 'running',
    message: message || null,
  });
  return latestRunStmt.get(tenantSlug);
}

function finishRunById(runId, { status, recordsAdded, message }) {
  finishRun.run({
    run_id: runId,
    finished_at: new Date().toISOString(),
    status,
    records_added: Number.isFinite(recordsAdded) ? recordsAdded : null,
    message: message || null,
  });
  return db.prepare('SELECT * FROM scraper_runs WHERE run_id = ?').get(runId);
}

function getStatus(tenantSlug) {
  return getStatusStmt.get(tenantSlug) || null;
}

function listStatus() {
  return listStatusStmt.all();
}

function setPaused(tenantSlug, paused) {
  upsertStatusStmt.run({ tenant_slug: tenantSlug, paused: paused ? 1 : 0 });
  return getStatusStmt.get(tenantSlug);
}

function listAllRuns(limit = 50) {
  const cap = Math.max(1, Math.min(500, Number(limit) || 50));
  return listRunsStmt.all(cap);
}

module.exports = { startRun, finishRunById, getStatus, listStatus, setPaused, listAllRuns };
