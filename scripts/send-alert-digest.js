'use strict';

/**
 * send-alert-digest.js
 *
 * Runs daily (or on demand) to generate per-reader alert digests.
 *
 * MVP behavior:
 * - Reads SQLite `reader_alerts` table.
 * - For each enabled alert, queries Postgres `generated_articles` for rows
 *   published since the alert's last_sent_at (or 24 hours ago).
 * - Matches: county alerts on `county = target`; keyword alerts on ILIKE
 *   against headline and body.
 * - Writes the digest HTML to `alert_digests` and logs it to stdout.
 * - Does NOT send real email until SMTP is configured; this lets operators
 *   verify the output and a future mailer worker can pick it up.
 */

const path = require('path');

// Load env from .env if present.
try {
  require('../src/lib/load-env').loadEnv();
} catch (_err) {
  // ignore
}

const db = require('../src/db');
const pg = require('../src/db/pg');

const DIGEST_WINDOW_HOURS = 24;

function ensureTables() {
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

function listEnabledAlerts() {
  return db.db.prepare(`
    SELECT a.id, a.reader_id, a.alert_type, a.target, a.frequency, a.last_sent_at,
           u.email, u.state_slug
      FROM reader_alerts a
      JOIN reader_users u ON u.id = a.reader_id
     WHERE a.is_enabled = 1
     ORDER BY a.reader_id, a.id
  `).all();
}

function getReaderCounties(stateSlug) {
  if (!stateSlug) return [];
  // Pull distinct counties from generated_articles for this state.
  return pg.adminQuery(
    `SELECT DISTINCT county FROM generated_articles WHERE state = $1 AND county IS NOT NULL ORDER BY county`,
    [String(stateSlug).toLowerCase()]
  );
}

async function findMatchesForAlert(alert) {
  const since = new Date(Date.now() - DIGEST_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  if (alert.alert_type === 'county') {
    const result = await pg.adminQuery(
      `SELECT id, state, county, headline, body, created_at
         FROM generated_articles
        WHERE county = $1
          AND created_at > $2
          AND publication_status = 'published'
        ORDER BY created_at DESC
        LIMIT 50`,
      [alert.target, since]
    );
    return result.ok ? result.rows : [];
  }

  const term = `%${alert.target}%`;
  const result = await pg.adminQuery(
    `SELECT id, state, county, headline, body, created_at
       FROM generated_articles
      WHERE (headline ILIKE $1 OR body ILIKE $1)
        AND created_at > $2
        AND publication_status = 'published'
      ORDER BY created_at DESC
      LIMIT 50`,
    [term, since]
  );
  return result.ok ? result.rows : [];
}

function formatDigestDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function stateNameFromSlug(slug) {
  try {
    const registry = require('../src/data/state-registry');
    const t = registry.getBySlug(String(slug || '').toLowerCase());
    return t ? t.name : slug;
  } catch (_err) {
    return slug;
  }
}

function buildDigestHtml(reader, alertMatches) {
  const total = alertMatches.reduce((sum, m) => sum + m.matches.length, 0);
  if (total === 0) return null;

  const rows = alertMatches.map((am) => {
    const targetLabel = am.alert.alert_type === 'county'
      ? `${am.alert.target} County`
      : am.alert.target;
    const items = am.matches.map((m) => `
      <li class="digest-item">
        <a href="https://${m.state}.blotter.host/blotter/${m.id}">${m.headline}</a>
        <span class="digest-item__meta">${stateNameFromSlug(m.state)}${m.county ? ` &middot; ${m.county} County` : ''} &middot; ${formatDigestDate(m.created_at)}</span>
        <p class="digest-item__summary">${m.body.replace(/<[^>]+>/g, ' ').trim().slice(0, 200)}${m.body.length > 200 ? '…' : ''}</p>
      </li>
    `).join('');
    return `
      <section class="digest-section">
        <h3 class="digest-section__heading">${am.alert.alert_type === 'county' ? 'County' : 'Keyword'}: ${targetLabel}</h3>
        <ul class="digest-list">${items}</ul>
      </section>
    `;
  }).join('');

  return `
    <div class="digest">
      <h2 class="digest__title">Your ${formatDigestDate(new Date().toISOString())} blotter.host digest</h2>
      <p class="digest__summary">${total} new report${total === 1 ? '' : 's'} matched your alerts.</p>
      ${rows}
      <p class="digest__footer">
        Manage alerts: <a href="https://blotter.host/me/alerts">blotter.host/me/alerts</a>
      </p>
    </div>
  `;
}

async function sendDigest(reader, alertMatches) {
  const html = buildDigestHtml(reader, alertMatches);
  if (!html) {
    console.log(`[digest] no matches for ${reader.email}`);
    return { sent: false, count: 0 };
  }

  const count = alertMatches.reduce((sum, m) => sum + m.matches.length, 0);
  const alertIds = alertMatches.map((m) => m.alert.id).join(',');

  db.db.prepare(`
    INSERT INTO alert_digests (reader_id, alert_ids, matched_count, digest_html, status)
    VALUES (?, ?, ?, ?, 'logged')
  `).run(reader.id, alertIds, count, html);

  db.db.prepare(`
    UPDATE reader_alerts SET last_sent_at = datetime('now') WHERE reader_id = ?
  `).run(reader.id);

  console.log(`[digest] ${reader.email}: ${count} match(es)`);
  console.log(html);
  return { sent: true, count };
}

async function main() {
  ensureTables();

  if (!pg.isConfigured()) {
    console.log('[digest] Postgres not configured; nothing to do.');
    return { ok: true, sent: 0 };
  }

  const alerts = listEnabledAlerts();
  if (!alerts.length) {
    console.log('[digest] no alerts configured.');
    return { ok: true, sent: 0 };
  }

  // Group alerts by reader.
  const byReader = new Map();
  for (const alert of alerts) {
    if (!byReader.has(alert.reader_id)) {
      byReader.set(alert.reader_id, {
        id: alert.reader_id,
        email: alert.email,
        state_slug: alert.state_slug,
        alerts: [],
      });
    }
    byReader.get(alert.reader_id).alerts.push(alert);
  }

  let totalSent = 0;
  for (const reader of byReader.values()) {
    const alertMatches = [];
    for (const alert of reader.alerts) {
      const matches = await findMatchesForAlert(alert);
      if (matches.length) {
        alertMatches.push({ alert, matches });
      }
    }
    const result = await sendDigest(reader, alertMatches);
    if (result.sent) totalSent += 1;
  }

  console.log(`[digest] complete. ${totalSent} reader(s) with matches.`);
  return { ok: true, sent: totalSent };
}

if (require.main === module) {
  main().then((result) => {
    process.exit(result.ok ? 0 : 1);
  }).catch((err) => {
    console.error('[digest] failed', err);
    process.exit(1);
  });
}

module.exports = { main, findMatchesForAlert, buildDigestHtml };
