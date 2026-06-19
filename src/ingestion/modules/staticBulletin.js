'use strict';

const { scrapeStaticPage } = require('../static_scraper');
const bulletin = require('./bulletin');

async function runBatch(input, deps = {}) {
  const url = input.sourceUrl || input.url;
  if (!url) {
    throw new Error('sourceUrl is required for staticBulletin strategy');
  }

  const scrape = deps.scrapeStaticPage || scrapeStaticPage;
  const page = await scrape(url);
  const text = page && page.text ? page.text : page && page.rawText ? page.rawText : '';

  if (!text || !String(text).trim()) {
    throw new Error('static page returned no text');
  }

  return bulletin.ingestBulletin({
    state: input.state,
    sourceType: input.sourceType || input.source_type || 'bulletin',
    sourceUrl: url,
    sourceName: input.sourceName || input.source_name || 'staticBulletin',
    text,
    rawHtml: page && page.rawHtml ? page.rawHtml : null,
    rawPayload: {
      mode: 'static',
      url,
    },
  });
}

module.exports = {
  runBatch,
};
