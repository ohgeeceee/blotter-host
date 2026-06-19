'use strict';

const Parser = require('rss-parser');
const bulletin = require('./bulletin');

const rssParser = new Parser({
  headers: { 'User-Agent': 'blotter.host RSS scraper' },
  timeout: 20000,
});

function cleanRssText(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildRawText(entry, feedTitle) {
  const parts = [];
  if (feedTitle) parts.push(`Feed: ${feedTitle}`);
  if (entry.title) parts.push(`Title: ${cleanRssText(entry.title)}`);
  if (entry.pubDate || entry.isoDate) parts.push(`Published: ${entry.isoDate || entry.pubDate}`);
  if (entry.contentSnippet || entry.content) {
    parts.push(`Summary: ${cleanRssText(entry.contentSnippet || entry.content)}`);
  } else if (entry.summary) {
    parts.push(`Summary: ${cleanRssText(entry.summary)}`);
  }
  if (entry.link) parts.push(`Link: ${entry.link}`);
  return parts.join('\n');
}

async function runBatch(input, deps = {}) {
  const url = input.sourceUrl || input.url;
  if (!url) {
    throw new Error('sourceUrl is required for rssBulletin strategy');
  }

  const parser = deps.rssParser || rssParser;
  const feed = await parser.parseURL(url);
  const feedTitle = feed.title || input.sourceName || url;

  const maxEntries = input.maxEntries || 10;
  const entries = (feed.items || []).slice(0, maxEntries);
  const results = [];

  for (const entry of entries) {
    const rawText = buildRawText(entry, feedTitle);
    if (!rawText.trim()) continue;

    const result = await bulletin.ingestBulletin({
      state: input.state,
      sourceType: input.sourceType || input.source_type || 'news_bulletin',
      sourceUrl: entry.link || url,
      sourceName: input.sourceName || input.source_name || feedTitle,
      text: rawText,
      rawHtml: null,
      rawPayload: {
        mode: 'rss',
        feedUrl: url,
        feedTitle,
        entry: {
          title: entry.title,
          link: entry.link,
          pubDate: entry.pubDate,
          isoDate: entry.isoDate,
        },
      },
    });

    results.push(result);
  }

  return {
    ok: true,
    mode: 'rss',
    feedUrl: url,
    feedTitle,
    entriesAttempted: entries.length,
    results,
  };
}

module.exports = {
  runBatch,
  buildRawText,
};
