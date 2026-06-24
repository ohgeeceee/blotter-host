'use strict';

const express = require('express');
const https = require('https');

const router = express.Router();

const SYSTEM_PROMPT = `You are the blotter.host assistant. blotter.host is the front door to a 50-state public records network. Each state has its own subdomain (e.g., montana.blotter.host) that publishes plain-language summaries of public records.

Your job:
- Help visitors understand the blotter.host network and find the right state page.
- Explain how to search the network, subscribe to state updates, or browse the directory.
- Guide users to pages like /network, /about, /subscribe, /login, or /register.
- Explain that each state subdomain is independently operated and sourced from official public records.
- For questions about a specific state's records, direct the user to that state's subdomain or the network directory.

Hard rules:
- Never give legal advice.
- Never invent state coverage, partnerships, or record details.
- Be concise, friendly, and helpful. Two to three sentences unless the user asks for detail.`;

const gatewayUrl = process.env.CHAT_GATEWAY_URL || 'http://127.0.0.1:20128/v1/chat/completions';
const gatewayKey = process.env.CHAT_GATEWAY_KEY || '';
const model = process.env.CHAT_MODEL || 'Main';

// Simple in-memory rate limit: 20 requests per IP per 5 minutes.
const rateLimit = new Map();
const RATE_LIMIT = 20;
const WINDOW_MS = 5 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimit.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimit.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true };
  }
  if (entry.count >= RATE_LIMIT) {
    return { ok: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count += 1;
  return { ok: true };
}

function parseGatewayUrl(url) {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const module = isHttps ? https : require('http');
  return {
    module,
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
  };
}

router.post('/', express.json({ limit: '32kb' }), (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }

  if (!gatewayKey) {
    return res.status(503).json({ error: 'Chat not configured' });
  }

  const messages = req.body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Missing messages' });
  }
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || typeof last.content !== 'string') {
    return res.status(400).json({ error: 'Invalid messages' });
  }

  const upstreamMessages = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages.slice(-10)];

  const { module, hostname, port, path } = parseGatewayUrl(gatewayUrl);

  const postData = JSON.stringify({
    model,
    messages: upstreamMessages,
    stream: true,
    max_tokens: 800,
    temperature: 0.5,
  });

  const requestOptions = {
    hostname,
    port,
    path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${gatewayKey}`,
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const upstreamReq = module.request(requestOptions, (upstreamRes) => {
    let buf = '';
    upstreamRes.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = block.split('\n');
        let data = '';
        for (const line of lines) {
          if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const text = parsed.choices?.[0]?.delta?.content || '';
          if (text) {
            res.write(`data: ${JSON.stringify({ text })}\n\n`);
          }
        } catch {
          // ignore malformed SSE chunks
        }
      }
    });
    upstreamRes.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
    });
    upstreamRes.on('error', (err) => {
      console.error('[chat] upstream error', err.message);
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    });
  });

  upstreamReq.on('error', (err) => {
    console.error('[chat] upstream connection error', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  });

  upstreamReq.write(postData);
  upstreamReq.end();
});

router.get('/', (req, res) => {
  res.json({ ok: true, online: Boolean(gatewayKey && gatewayUrl), model });
});

module.exports = router;
