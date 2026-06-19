'use strict';

const logger = require('../logger');

const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15000;

const clients = new Set();

function sseHeaders(res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function formatEvent({ id, event, data }) {
  let out = '';
  if (id !== undefined && id !== null) out += `id: ${id}\n`;
  if (event) out += `event: ${event}\n`;
  out += `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n`;
  out += '\n';
  return out;
}

function send(client, payload) {
  if (client.closed) return;
  try {
    client.res.write(payload);
  } catch (_err) {
    client.closed = true;
  }
}

function heartbeatTick() {
  for (const client of clients) {
    if (client.closed) { clients.delete(client); continue; }
    if (Date.now() - client.lastBeat < HEARTBEAT_INTERVAL_MS) continue;
    client.lastBeat = Date.now();
    send(client, ': keep-alive\n\n');
  }
}

const ticker = setInterval(heartbeatTick, HEARTBEAT_INTERVAL_MS);
if (typeof ticker.unref === 'function') ticker.unref();

function pump(client) {
  try {
    const rows = logger.tail({ sinceId: client.lastId, limit: 200, tenant: client.tenant });
    if (rows.length) {
      client.lastId = rows[rows.length - 1].id;
      for (const row of rows) {
        send(client, formatEvent({ id: row.id, event: 'log', data: row }));
      }
    }
  } catch (err) {
    send(client, formatEvent({ event: 'error', data: { message: err.message } }));
  }
}

function attach(req, res, { tenant = null } = {}) {
  sseHeaders(res);

  const lastEventId = parseInt(req.headers['last-event-id'], 10);
  const client = {
    res,
    tenant,
    lastId: Number.isFinite(lastEventId) ? lastEventId : 0,
    lastBeat: Date.now(),
    closed: false,
    poll: null,
  };
  clients.add(client);

  send(client, formatEvent({ event: 'hello', data: { tenant, sinceId: client.lastId } }));

  pump(client);
  client.poll = setInterval(() => pump(client), POLL_INTERVAL_MS);
  if (typeof client.poll.unref === 'function') client.poll.unref();

  const close = () => {
    if (client.closed) return;
    client.closed = true;
    clearInterval(client.poll);
    clients.delete(client);
    try { res.end(); } catch (_e) { /* ignore */ }
  };

  req.on('close', close);
  req.on('aborted', close);
  res.on('close', close);

  return client;
}

function clientCount() {
  return clients.size;
}

module.exports = { attach, clientCount };
