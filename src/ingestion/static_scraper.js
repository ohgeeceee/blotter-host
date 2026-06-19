'use strict';

const { normalizeText } = require('./ingestion_guard');

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

async function scrapeStaticPage(url, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; blotter.host/1.0)',
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${url}`);
    }
    const rawHtml = await response.text();
    const text = normalizeText(stripHtml(rawHtml));
    return { url, rawHtml, text };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  stripHtml,
  scrapeStaticPage,
};
