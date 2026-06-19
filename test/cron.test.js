'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const cron = require('../src/cron');

test('createScheduler triggers both ingestion and processor cycles when due', async () => {
  const calls = [];
  const scheduler = cron.createScheduler({
    log: {
      info: (...args) => calls.push(['info', ...args]),
      error: (...args) => calls.push(['error', ...args]),
    },
    cronLib: {
      schedule(_expr, cb) {
        calls.push(['schedule', _expr]);
        return {
          start() {
            calls.push(['start']);
            cb();
          },
          stop() {
            calls.push(['stop']);
          },
          destroy() {
            calls.push(['destroy']);
          },
        };
      },
    },
    discoverModules: () => [
      {
        name: 'bulletin',
        run: async () => ({ ok: true, count: 1 }),
      },
    ],
    runProcessor: async (limit) => ({ ok: true, count: limit }),
  });

  const stop = scheduler.start();
  await scheduler.tick();
  stop();

  assert.equal(calls.some((row) => row[0] === 'schedule'), true);
  assert.equal(calls.some((row) => row[0] === 'start'), true);
  assert.equal(calls.some((row) => row[0] === 'info' && String(row[1]).includes('ingestion cycle complete')), true);
  assert.equal(calls.some((row) => row[0] === 'info' && String(row[1]).includes('processor cycle complete')), true);
  assert.equal(calls.some((row) => row[0] === 'stop'), true);
  assert.equal(calls.some((row) => row[0] === 'destroy'), true);
});

test('bulletin scheduled ingestion skips cleanly without configured targets', async () => {
  const bulletin = require('../src/ingestion/modules/bulletin');
  const result = await bulletin.runScheduledIngestion({ targets: [] });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.count, 0);
});
