'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { logIngestionEvent } = require('./postgres');

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function sha256Fingerprint(text) {
  return crypto.createHash('sha256').update(normalizeText(text), 'utf8').digest('hex');
}

function captureStack(err) {
  if (!err) return '';
  return err.stack || `${err.name || 'Error'}: ${err.message || String(err)}`;
}

function buildFailurePayload(details) {
  return {
    state: details.state || null,
    source_type: details.sourceType || details.source_type || null,
    source_name: details.sourceName || details.source_name || null,
    source_url: details.sourceUrl || details.source_url || null,
    status: details.status || 'failed',
    error_type: details.errorType || details.error_type || null,
    error_message: details.errorMessage || details.error_message || null,
    stack_trace: details.stackTrace || details.stack_trace || null,
  };
}

async function notifyWebhook(payload) {
  const webhookUrl = String(process.env.INGESTION_WEBHOOK_URL || '').trim();
  if (!webhookUrl) return { ok: false, skipped: true };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { ok: response.ok, status: response.status };
}

async function runGuarded(task, details) {
  try {
    const result = await task();
    return { ok: true, status: 'success', result };
  } catch (err) {
    const failure = buildFailurePayload({
      ...details,
      status: 'failed',
      errorType: err && err.name,
      errorMessage: err && err.message,
      stackTrace: captureStack(err),
    });

    await logIngestionEvent(failure);
    try {
      await notifyWebhook(failure);
    } catch (_notifyErr) {
      // non-fatal by design
    }

    return {
      ok: false,
      status: 'failed',
      error: failure.error_message,
      errorType: failure.error_type,
      failure,
    };
  }
}

function discoverIngestionModules(dir = path.join(__dirname, 'modules')) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => {
      const mod = require(path.join(dir, entry.name));
      return {
        name: entry.name.replace(/\.js$/, ''),
        module: mod,
        run:
          typeof mod.runScheduledIngestion === 'function'
            ? mod.runScheduledIngestion
            : typeof mod.runBatch === 'function'
              ? mod.runBatch
              : typeof mod.run === 'function' && mod.run.length === 0
                ? mod.run
                : null,
      };
    })
    .filter((entry) => typeof entry.run === 'function');
}

module.exports = {
  normalizeText,
  sha256Fingerprint,
  captureStack,
  buildFailurePayload,
  notifyWebhook,
  runGuarded,
  discoverIngestionModules,
};
