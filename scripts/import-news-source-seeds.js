#!/usr/bin/env node
'use strict';

/**
 * Import curated news-source seeds into the control DB as disabled proposals.
 *
 * Usage:
 *   node scripts/import-news-source-seeds.js [path/to/news-source-seeds.json]
 *
 * Environment:
 *   CONTROL_DB_PATH - override the default control DB location.
 *   ENABLE_SEEDS    - if set to "1" or "true", seeds are imported enabled.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
process.env.CONTROL_DB_PATH = process.env.CONTROL_DB_PATH || path.join(ROOT, 'data', 'control.db');

const controlDb = require(path.join(ROOT, 'src', 'db', 'control'));

const SEEDS_PATH = process.argv[2] || path.join(ROOT, 'data', 'news-source-seeds.json');
const ENABLE = /^(1|true|yes)$/i.test(process.env.ENABLE_SEEDS || '');

function log(...args) {
  // eslint-disable-next-line no-console
  console.log(...args);
}

function main() {
  if (!fs.existsSync(SEEDS_PATH)) {
    log(`Seed file not found: ${SEEDS_PATH}`);
    process.exit(1);
  }

  controlDb.setup();

  let seeds;
  try {
    seeds = JSON.parse(fs.readFileSync(SEEDS_PATH, 'utf8'));
  } catch (err) {
    log(`Failed to parse seed file: ${err.message}`);
    process.exit(1);
  }

  const sources = Array.isArray(seeds) ? seeds : seeds.sources;
  if (!Array.isArray(sources)) {
    log('Seed file must contain a top-level array or a "sources" array.');
    process.exit(1);
  }

  const existingRows = controlDb.listNewsSources();
  const existingUrls = new Set(existingRows.map((r) => r.source_url.toLowerCase()));
  const existingKeys = new Set(
    existingRows.map((r) => `${r.state_slug.toLowerCase()}|${r.source_name.toLowerCase()}`)
  );

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const src of sources) {
    const stateSlug = String(src.state_slug || '').toLowerCase().trim();
    const sourceName = String(src.source_name || '').trim();
    const sourceUrl = String(src.source_url || '').trim();

    if (!stateSlug || !sourceName || !sourceUrl) {
      log(`Skipping invalid seed: ${JSON.stringify(src)}`);
      failed += 1;
      continue;
    }

    const urlKey = sourceUrl.toLowerCase();
    const nameKey = `${stateSlug}|${sourceName.toLowerCase()}`;

    if (existingUrls.has(urlKey) || existingKeys.has(nameKey)) {
      skipped += 1;
      continue;
    }

    try {
      controlDb.createNewsSource({
        state_slug: stateSlug,
        source_name: sourceName,
        source_url: sourceUrl,
        source_type: src.source_type || 'website',
        strategy: src.strategy || 'staticBulletin',
        is_enabled: ENABLE,
        priority: Number.isFinite(src.priority) ? src.priority : 100,
        metadata_json: JSON.stringify({ imported_from_seed: true, seed_version: seeds.version || null }),
      });
      created += 1;
    } catch (err) {
      log(`Failed to create source "${sourceName}": ${err.message}`);
      failed += 1;
    }
  }

  log('Import complete.');
  log(`  Created: ${created}`);
  log(`  Skipped (duplicate): ${skipped}`);
  log(`  Failed: ${failed}`);
  log(`  Total in seed file: ${sources.length}`);

  controlDb.close();
  process.exit(failed > 0 ? 2 : 0);
}

main();
