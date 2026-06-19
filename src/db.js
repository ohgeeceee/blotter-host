'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const CONTROL_DB_PATH = process.env.CONTROL_DB_PATH
  ? path.resolve(process.env.CONTROL_DB_PATH)
  : path.resolve(__dirname, '..', 'data', 'control.db');

fs.mkdirSync(path.dirname(CONTROL_DB_PATH), { recursive: true });

const db = new Database(CONTROL_DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS scraper_status (
    tenant_slug     TEXT PRIMARY KEY,
    paused          INTEGER NOT NULL DEFAULT 0,
    last_heartbeat  TEXT,
    last_status     TEXT,
    last_message    TEXT,
    last_run_id     TEXT,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scraper_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_slug     TEXT NOT NULL,
    run_id          TEXT NOT NULL UNIQUE,
    started_at      TEXT NOT NULL,
    finished_at     TEXT,
    status          TEXT NOT NULL,
    records_added   INTEGER,
    message         TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_scraper_runs_tenant_started
    ON scraper_runs(tenant_slug, started_at DESC);

  CREATE TABLE IF NOT EXISTS scraper_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              TEXT NOT NULL DEFAULT (datetime('now')),
    tenant_slug     TEXT,
    severity        TEXT NOT NULL,
    source          TEXT NOT NULL,
    run_id          TEXT,
    message         TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_scraper_logs_ts ON scraper_logs(ts DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_scraper_logs_tenant ON scraper_logs(tenant_slug, id DESC);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL,
    state_slug    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS password_resets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    reader_id   INTEGER NOT NULL REFERENCES reader_users(id) ON DELETE CASCADE,
    token       TEXT NOT NULL UNIQUE,
    expires_at  TEXT NOT NULL,
    used_at     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
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

db.exec(`
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

module.exports = { db, CONTROL_DB_PATH };
