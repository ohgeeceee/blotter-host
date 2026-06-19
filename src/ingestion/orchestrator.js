'use strict';

const path = require('node:path');
const sources = require('./config/sources');

function resolveStrategyModule(strategy, deps = {}) {
  if (deps.resolveStrategyModule) {
    return deps.resolveStrategyModule(strategy);
  }

  const candidates = [
    path.join(__dirname, 'modules', `${strategy}.js`),
    path.join(__dirname, `${strategy}.js`),
  ];

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (_err) {
      // try next candidate
    }
  }

  throw new Error(`Unknown ingestion strategy: ${strategy}`);
}

function pickEntryPoint(moduleExports) {
  return (
    moduleExports.runBatch ||
    moduleExports.orchestrate ||
    moduleExports.runScheduledIngestion ||
    moduleExports.ingestMany ||
    moduleExports.ingestBulletin ||
    moduleExports.ingestDynamicPage ||
    moduleExports.ingestOne ||
    null
  );
}

function buildStatePayload(source) {
  return {
    state: source.state,
    sourceType: source.type,
    sourceUrl: source.url,
    sourceName: source.name || source.type,
    strategy: source.strategy,
    selectors: source.selectors || null,
    mapping: source.mapping || null,
  };
}

async function runSource(source, deps = {}) {
  if (!source || typeof source !== 'object') {
    throw new Error('source is required');
  }
  if (!source.state) {
    throw new Error('source.state is required');
  }
  if (!source.strategy) {
    throw new Error('source.strategy is required');
  }

  const mod = resolveStrategyModule(source.strategy, deps);
  const entryPoint = pickEntryPoint(mod);
  if (!entryPoint) {
    throw new Error(`Strategy module "${source.strategy}" does not expose a runnable entrypoint`);
  }

  return entryPoint({
    ...buildStatePayload(source),
    source,
  }, deps);
}

async function runAllSources(list = sources, deps = {}) {
  const results = [];
  for (const source of list) {
    try {
      const result = await runSource(source, deps);
      results.push({
        state: source.state,
        strategy: source.strategy,
        ok: true,
        result,
      });
    } catch (err) {
      results.push({
        state: source.state,
        strategy: source.strategy,
        ok: false,
        error: err.message,
      });
    }
  }

  return {
    ok: true,
    count: results.length,
    results,
  };
}

async function runScheduledOrchestration(deps = {}) {
  return runAllSources(sources, deps);
}

module.exports = {
  sources,
  resolveStrategyModule,
  pickEntryPoint,
  buildStatePayload,
  runSource,
  runAllSources,
  runScheduledOrchestration,
};
