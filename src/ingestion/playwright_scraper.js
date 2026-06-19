'use strict';

const { normalizeText } = require('./ingestion_guard');

let playwright = null;
function getPlaywright() {
  if (playwright !== null) return playwright;
  try {
    playwright = require('playwright');
  } catch (_err) {
    playwright = undefined;
  }
  return playwright;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

async function extractWithPage(page, url, { maxScrolls = 12, scrollDelayMs = 500 } = {}) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
  let lastHeight = -1;
  for (let i = 0; i < maxScrolls; i += 1) {
    const height = await page.evaluate(() => document.body.scrollHeight);
    if (height === lastHeight) break;
    lastHeight = height;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(scrollDelayMs);
  }
  const rawHtml = await page.content();
  const text = normalizeText(stripHtml(rawHtml));
  return { url, rawHtml, text };
}

async function scrapeDynamicPage(url, options = {}) {
  const p = getPlaywright();
  if (!p) {
    throw new Error('playwright is not installed');
  }
  const browser = await p.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    return await extractWithPage(page, url, options);
  } finally {
    await browser.close();
  }
}

module.exports = {
  getPlaywright,
  extractWithPage,
  scrapeDynamicPage,
  stripHtml,
};
