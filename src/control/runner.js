'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const logger = require('../logger');
const store = require('./store');

const MAX_RUN_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 256 * 1024;

function parseCommand(cmd) {
  if (Array.isArray(cmd)) return cmd.map(String);
  if (typeof cmd !== 'string') throw new Error('scraperCommand must be string or array');

  const tokens = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += c;
    }
  }
  if (cur) tokens.push(cur);
  if (quote) throw new Error('Unterminated quote in scraperCommand');
  if (tokens.length === 0) throw new Error('Empty scraperCommand');
  return tokens;
}

function resolveCommand(tenant) {
  if (!tenant.scraperCommand) return null;
  let tokens;
  try {
    tokens = parseCommand(tenant.scraperCommand);
  } catch (err) {
    return { error: err.message };
  }

  let cwd = tenant.scraperCwd || process.cwd();
  if (tokens[0] === 'cd' && tokens.includes('&&')) {
    const idx = tokens.indexOf('&&');
    cwd = path.resolve(cwd, tokens[1]);
    tokens = tokens.slice(idx + 1);
  }

  if (tokens.length === 0) return { error: 'No executable after stripping cd prefix' };
  return { cwd, argv: tokens };
}

function makeRunId(tenantSlug) {
  return `r-${Date.now()}-${tenantSlug}-${crypto.randomBytes(3).toString('hex')}`;
}

function writeHeartbeats(tenant, payload) {
  const written = [];
  const basePayload = {
    records: Number.isFinite(payload.records) ? payload.records : null,
    last_successful_run: payload.ts,
    status: payload.status,
    message: payload.message || null,
    run_id: payload.runId,
  };

  if (tenant.heartbeatPath) {
    try {
      fs.writeFileSync(tenant.heartbeatPath, JSON.stringify(basePayload, null, 2));
      written.push(tenant.heartbeatPath);
    } catch (err) {
      logger.log({
        tenant: tenant.slug,
        severity: 'warn',
        source: 'runner',
        runId: payload.runId,
        message: `heartbeat write failed at ${tenant.heartbeatPath}: ${err.message}`,
      });
    }
  }

  if (tenant.dbPath) {
    const statsPath = path.join(path.dirname(tenant.dbPath), 'tenant_stats.json');
    try {
      const statsPayload = {
        records: basePayload.records,
        last_successful_run: basePayload.last_successful_run,
      };
      if (basePayload.status) statsPayload.status = basePayload.status;
      fs.writeFileSync(statsPath, JSON.stringify(statsPayload, null, 2));
      written.push(statsPath);
    } catch (err) {
      logger.log({
        tenant: tenant.slug,
        severity: 'warn',
        source: 'runner',
        runId: payload.runId,
        message: `tenant_stats.json write failed: ${err.message}`,
      });
    }
  }

  return written;
}

function streamLines(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      onLine(line);
    }
    if (buffer.length > MAX_OUTPUT_BYTES) {
      onLine(buffer.slice(0, MAX_OUTPUT_BYTES) + ' …[truncated]');
      buffer = '';
    }
  });
  stream.on('end', () => { if (buffer) onLine(buffer); });
}

const activeRuns = new Map();

function isRunning(tenantSlug) {
  return activeRuns.has(tenantSlug);
}

function trigger(tenant, { source = 'admin' } = {}) {
  if (isRunning(tenant.slug)) {
    return { ok: false, status: 'already-running' };
  }

  const status = store.getStatus(tenant.slug);
  if (status && status.paused) {
    return { ok: false, status: 'paused' };
  }

  const resolved = resolveCommand(tenant);
  if (resolved && resolved.error) {
    return { ok: false, status: 'bad-command', error: resolved.error };
  }
  if (!resolved) {
    return { ok: false, status: 'no-command' };
  }

  const runId = makeRunId(tenant.slug);
  store.startRun(tenant.slug, runId, `triggered via ${source}`);

  logger.log({
    tenant: tenant.slug,
    severity: 'info',
    source,
    runId,
    message: `starting scraper: ${resolved.argv.join(' ')} (cwd=${resolved.cwd})`,
  });

  let proc;
  try {
    proc = spawn(resolved.argv[0], resolved.argv.slice(1), {
      cwd: resolved.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    logger.log({
      tenant: tenant.slug,
      severity: 'error',
      source,
      runId,
      message: `spawn failed: ${err.message}`,
    });
    store.finishRunById(runId, { status: 'failed', message: err.message });
    return { ok: false, status: 'spawn-failed', error: err.message };
  }

  activeRuns.set(tenant.slug, { proc, runId, startedAt: Date.now() });

  const killTimer = setTimeout(() => {
    logger.log({
      tenant: tenant.slug, severity: 'warn', source, runId,
      message: `run exceeded ${MAX_RUN_MS / 60000}m, killing`,
    });
    try { proc.kill('SIGTERM'); } catch (_e) { /* ignore */ }
  }, MAX_RUN_MS);

  streamLines(proc.stdout, (line) => {
    logger.log({
      tenant: tenant.slug, severity: 'info', source, runId, message: line,
    });
  });
  streamLines(proc.stderr, (line) => {
    logger.log({
      tenant: tenant.slug, severity: 'warn', source, runId, message: line,
    });
  });

  proc.on('error', (err) => {
    logger.log({
      tenant: tenant.slug, severity: 'error', source, runId,
      message: `process error: ${err.message}`,
    });
  });

  proc.on('exit', (code, signal) => {
    clearTimeout(killTimer);
    activeRuns.delete(tenant.slug);

    const success = code === 0;
    const statusText = success ? 'success' : (signal ? `killed-${signal}` : `failed-${code}`);
    const ts = new Date().toISOString();
    const message = signal
      ? `process exited via signal ${signal}`
      : `process exited with code ${code}`;

    logger.log({
      tenant: tenant.slug, severity: success ? 'info' : 'error', source, runId,
      message,
    });

    store.finishRunById(runId, {
      status: statusText,
      message,
    });

    writeHeartbeats(tenant, {
      status: success ? 'success' : 'failed',
      ts,
      message,
      runId,
    });
  });

  return { ok: true, runId };
}

module.exports = { trigger, isRunning, activeRuns, resolveCommand, parseCommand };
