'use strict';

const { processRecordsWithClaude } = require('./ingestion/processor');
const { discoverIngestionModules } = require('./ingestion/ingestion_guard');
const { runScheduledIngestion: runAllConfiguredIngestion } = require('./ingestion/scheduler');

const INGESTION_INTERVAL_MS = 3 * 60 * 60 * 1000;
const PROCESSOR_INTERVAL_MS = 3.5 * 60 * 60 * 1000;
const POLL_CRON_EXPRESSION = '* * * * *';

function nowMs() {
  return Date.now();
}

function resolveCronLib(cronLib) {
  if (cronLib) {
    return cronLib;
  }

  try {
    return require('node-cron');
  } catch (err) {
    const wrapped = new Error('node-cron is not installed. Run npm install before starting cron.');
    wrapped.cause = err;
    throw wrapped;
  }
}

function createScheduler({ log = console, cronLib = null, discoverModules = discoverIngestionModules, runProcessor = processRecordsWithClaude } = {}) {
  let started = false;
  let ingestionNextAt = 0;
  let processorNextAt = 0;

  async function runIngestionCycle() {
    try {
      const result = await runAllConfiguredIngestion();
      log.info?.('[cron] ingestion cycle complete', { count: result && result.count, skipped: result && result.skipped });
      if (result && Array.isArray(result.results)) {
        const failed = result.results.filter((r) => !r.ok);
        if (failed.length) {
          log.warn?.('[cron] ingestion failures', { count: failed.length, sample: failed.slice(0, 3) });
        }
      }
      return result;
    } catch (err) {
      log.error?.('[cron] ingestion cycle failed', err);
      return { ok: false, error: err.message };
    }
  }

  async function runProcessorCycle() {
    return runProcessor(10);
  }

  async function tick() {
    const current = nowMs();

    if (!ingestionNextAt) {
      ingestionNextAt = current;
    }
    if (!processorNextAt) {
      processorNextAt = current;
    }

    if (current >= ingestionNextAt) {
      ingestionNextAt = current + INGESTION_INTERVAL_MS;
      try {
        const results = await runIngestionCycle();
        log.info?.('[cron] ingestion cycle complete', { results });
      } catch (err) {
        log.error?.('[cron] ingestion cycle failed', err);
      }
    }

    if (current >= processorNextAt) {
      processorNextAt = current + PROCESSOR_INTERVAL_MS;
      try {
        const result = await runProcessorCycle();
        log.info?.('[cron] processor cycle complete', { count: result?.count || 0 });
      } catch (err) {
        log.error?.('[cron] processor cycle failed', err);
      }
    }
  }

  function start() {
    if (started) {
      return stop;
    }
    started = true;
    const cronImpl = resolveCronLib(cronLib);
    const task = cronImpl.schedule(POLL_CRON_EXPRESSION, () => {
      void tick();
    });
    task.start();

    return function stop() {
      if (!started) return;
      started = false;
      task.stop();
      task.destroy();
    };
  }

  return {
    start,
    tick,
    getState() {
      return {
        started,
        ingestionNextAt,
        processorNextAt,
      };
    },
  };
}

const defaultScheduler = createScheduler();

function startCron(options) {
  return createScheduler(options).start();
}

module.exports = {
  INGESTION_INTERVAL_MS,
  PROCESSOR_INTERVAL_MS,
  createScheduler,
  defaultScheduler,
  startCron,
};
