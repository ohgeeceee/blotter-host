'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DB_PATH = path.join(ROOT, 'data', 'control.db');

let db = null;

function getDbPath() {
  return String(process.env.CONTROL_DB_PATH || DEFAULT_DB_PATH).trim() || DEFAULT_DB_PATH;
}

function getDb() {
  if (db) return db;
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function setup() {
  const conn = getDb();
  conn.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users(username);
    CREATE INDEX IF NOT EXISTS idx_admin_users_active ON admin_users(is_active);

    CREATE TABLE IF NOT EXISTS news_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state_slug TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'rss',
      strategy TEXT NOT NULL DEFAULT 'rssBulletin',
      is_enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CONSTRAINT news_sources_type_allowed CHECK (source_type IN ('rss', 'website')),
      CONSTRAINT news_sources_strategy_allowed CHECK (strategy IN ('rssBulletin', 'staticBulletin', 'dynamicBulletin'))
    );

    CREATE INDEX IF NOT EXISTS idx_news_sources_state ON news_sources(state_slug);
    CREATE INDEX IF NOT EXISTS idx_news_sources_enabled ON news_sources(is_enabled);
  `);
  return { ok: true, dbPath: getDbPath() };
}

function close() {
  if (!db) return;
  db.close();
  db = null;
}

/* --------------------------------------------------------------------------
 * News sources
 * -------------------------------------------------------------------------- */

function normalizeNewsSourceRow(row) {
  if (!row) return row;
  return {
    id: row.id,
    state_slug: row.state_slug,
    source_name: row.source_name,
    source_url: row.source_url,
    source_type: row.source_type,
    strategy: row.strategy,
    is_enabled: !!row.is_enabled,
    priority: row.priority,
    metadata_json: row.metadata_json || '{}',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listNewsSources(stateSlug = null) {
  const conn = getDb();
  if (stateSlug) {
    return conn.prepare('SELECT * FROM news_sources WHERE state_slug = ? ORDER BY priority ASC, source_name ASC')
      .all(String(stateSlug).toLowerCase())
      .map(normalizeNewsSourceRow);
  }
  return conn.prepare('SELECT * FROM news_sources ORDER BY state_slug, priority ASC, source_name ASC')
    .all()
    .map(normalizeNewsSourceRow);
}

function getNewsSourceById(id) {
  const conn = getDb();
  const row = conn.prepare('SELECT * FROM news_sources WHERE id = ?').get(Number(id));
  return row ? normalizeNewsSourceRow(row) : null;
}

function createNewsSource(fields) {
  const conn = getDb();
  const stateSlug = String(fields.state_slug || '').toLowerCase().trim();
  const sourceName = String(fields.source_name || '').trim();
  const sourceUrl = String(fields.source_url || '').trim();
  const sourceType = String(fields.source_type || 'rss').toLowerCase().trim();
  const strategy = String(fields.strategy || 'rssBulletin').trim();
  const isEnabled = fields.is_enabled === false || fields.is_enabled === 0 ? 0 : 1;
  const priority = Math.max(0, parseInt(fields.priority, 10) || 100);
  const metadataJson = String(fields.metadata_json || '{}').trim() || '{}';

  const result = conn.prepare(
    `INSERT INTO news_sources (state_slug, source_name, source_url, source_type, strategy, is_enabled, priority, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(stateSlug, sourceName, sourceUrl, sourceType, strategy, isEnabled, priority, metadataJson);

  return getNewsSourceById(result.lastInsertRowid);
}

function updateNewsSource(id, fields) {
  const conn = getDb();
  const existing = getNewsSourceById(id);
  if (!existing) return null;

  const stateSlug = fields.state_slug !== undefined
    ? String(fields.state_slug || '').toLowerCase().trim()
    : existing.state_slug;
  const sourceName = fields.source_name !== undefined
    ? String(fields.source_name || '').trim()
    : existing.source_name;
  const sourceUrl = fields.source_url !== undefined
    ? String(fields.source_url || '').trim()
    : existing.source_url;
  const sourceType = fields.source_type !== undefined
    ? String(fields.source_type || 'rss').toLowerCase().trim()
    : existing.source_type;
  const strategy = fields.strategy !== undefined
    ? String(fields.strategy || 'rssBulletin').trim()
    : existing.strategy;
  const isEnabled = fields.is_enabled !== undefined
    ? (fields.is_enabled === false || fields.is_enabled === 0 ? 0 : 1)
    : (existing.is_enabled ? 1 : 0);
  const priority = fields.priority !== undefined
    ? Math.max(0, parseInt(fields.priority, 10) || 100)
    : existing.priority;
  const metadataJson = fields.metadata_json !== undefined
    ? (String(fields.metadata_json || '').trim() || '{}')
    : existing.metadata_json;

  conn.prepare(
    `UPDATE news_sources
        SET state_slug = ?,
            source_name = ?,
            source_url = ?,
            source_type = ?,
            strategy = ?,
            is_enabled = ?,
            priority = ?,
            metadata_json = ?,
            updated_at = datetime('now')
      WHERE id = ?`
  ).run(stateSlug, sourceName, sourceUrl, sourceType, strategy, isEnabled, priority, metadataJson, Number(id));

  return getNewsSourceById(id);
}

function deleteNewsSource(id) {
  const conn = getDb();
  const result = conn.prepare('DELETE FROM news_sources WHERE id = ?').run(Number(id));
  return { deleted: result.changes > 0 };
}

function listEnabledNewsSources(stateSlug = null) {
  const conn = getDb();
  if (stateSlug) {
    return conn.prepare(
      'SELECT * FROM news_sources WHERE state_slug = ? AND is_enabled = 1 ORDER BY priority ASC, source_name ASC'
    )
      .all(String(stateSlug).toLowerCase())
      .map(normalizeNewsSourceRow);
  }
  return conn.prepare('SELECT * FROM news_sources WHERE is_enabled = 1 ORDER BY state_slug, priority ASC, source_name ASC')
    .all()
    .map(normalizeNewsSourceRow);
}

module.exports = {
  getDbPath,
  getDb,
  setup,
  close,
  listNewsSources,
  getNewsSourceById,
  createNewsSource,
  updateNewsSource,
  deleteNewsSource,
  listEnabledNewsSources,
};
