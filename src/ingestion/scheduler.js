'use strict';

const orchestrator = require('./orchestrator');
const controlDb = require('../db/control');

const DEFAULT_MAX_ENTRIES = 10;

function newsSourceToOrchestratorSource(row) {
  let metadata = {};
  try {
    metadata = JSON.parse(row.metadata_json || '{}');
  } catch (_err) {
    metadata = {};
  }

  return {
    state: row.state_slug,
    type: row.source_type === 'rss' ? 'news_bulletin' : 'news_bulletin',
    name: row.source_name,
    url: row.source_url,
    strategy: row.strategy,
    maxEntries: metadata.max_entries || metadata.maxEntries || DEFAULT_MAX_ENTRIES,
  };
}

function loadNewsSourcesFromDb(stateSlug = null) {
  controlDb.setup();
  return controlDb.listEnabledNewsSources(stateSlug).map(newsSourceToOrchestratorSource);
}

/**
 * Run only the news sources stored in the control DB.
 */
async function runNewsSources(stateSlug = null, deps = {}) {
  const sources = loadNewsSourcesFromDb(stateSlug);
  if (!sources.length) {
    return { ok: true, skipped: true, reason: 'no news sources configured', count: 0, results: [] };
  }

  const results = [];
  for (const source of sources) {
    try {
      const result = await orchestrator.runSource(source, deps);
      results.push({ state: source.state, name: source.name || source.url, strategy: source.strategy, ok: true, result });
    } catch (err) {
      results.push({
        state: source.state,
        name: source.name || source.url,
        strategy: source.strategy,
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  return {
    ok: true,
    skipped: false,
    count: results.length,
    sourcesRun: results.length,
    results,
  };
}

/**
 * Cron entry point. Run with no arguments to ingest every source
 * declared in src/ingestion/config/sources.js PLUS every enabled
 * news source from the control DB.
 *
 * Resolves to: { ok, count, results, sourcesRun }
 */
async function runScheduledIngestion(options = {}) {
  const hardcodedSources = Array.isArray(options.sources) && options.sources.length
    ? options.sources
    : orchestrator.sources;

  const newsSources = options.includeNewsSources !== false
    ? loadNewsSourcesFromDb(options.stateSlug || null)
    : [];

  const sources = [...hardcodedSources, ...newsSources];

  if (!sources.length) {
    return { ok: true, skipped: true, reason: 'no sources configured', count: 0, results: [] };
  }

  const results = [];
  for (const source of sources) {
    try {
      const result = await orchestrator.runSource(source, options.deps || {});
      results.push({ state: source.state, name: source.name || source.url, strategy: source.strategy, ok: true, result });
    } catch (err) {
      results.push({
        state: source.state,
        name: source.name || source.url,
        strategy: source.strategy,
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  return {
    ok: true,
    skipped: false,
    count: results.length,
    sourcesRun: results.length,
    results,
  };
}

module.exports = {
  runScheduledIngestion,
  runNewsSources,
  loadNewsSourcesFromDb,
  newsSourceToOrchestratorSource,
};
