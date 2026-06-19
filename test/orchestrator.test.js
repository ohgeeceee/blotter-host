'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const orchestrator = require('../src/ingestion/orchestrator');

test('source registry exports state-specific source configs', () => {
  assert.equal(Array.isArray(orchestrator.sources), true);
  assert.equal(orchestrator.sources[0].state, 'idaho');
  assert.equal(orchestrator.sources[1].strategy, 'apiRoster');
});

test('runSource passes the current state and source metadata to the strategy entrypoint', async () => {
  const seen = [];
  const result = await orchestrator.runSource(
    {
      state: 'washington',
      type: 'police_blotter',
      strategy: 'apiRoster',
      url: 'https://api.example-wa-safety.gov/v1/feed',
      mapping: { name: 'full_name' },
    },
    {
      resolveStrategyModule: () => ({
        ingestBulletin: async (payload) => {
          seen.push(payload);
          return { ok: true, received: payload.state };
        },
      }),
    }
  );

  assert.equal(result.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].state, 'washington');
  assert.equal(seen[0].sourceType, 'police_blotter');
  assert.equal(seen[0].sourceUrl, 'https://api.example-wa-safety.gov/v1/feed');
});

test('runAllSources continues past a failing source', async () => {
  const result = await orchestrator.runAllSources(
    [
      { state: 'idaho', type: 'jail_roster', strategy: 'staticRoster', url: 'https://example.test' },
      { state: 'washington', type: 'police_blotter', strategy: 'apiRoster', url: 'https://example.test' },
    ],
    {
      resolveStrategyModule: (strategy) => {
        if (strategy === 'staticRoster') {
          return {
            runBatch: async () => ({ ok: true }),
          };
        }
        return {
          runBatch: async () => {
            throw new Error('boom');
          },
        };
      },
    }
  );

  assert.equal(result.count, 2);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].ok, false);
});
