'use strict';

const bulletin = require('./modules/bulletin');
const { normalizeText } = require('./ingestion_guard');

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function getBrowserDriver() {
  try {
    return {
      kind: 'playwright',
      module: require('playwright'),
    };
  } catch (_playwrightErr) {
    try {
      return {
        kind: 'puppeteer',
        module: require('puppeteer'),
      };
    } catch (_puppeteerErr) {
      throw new Error('Install either playwright or puppeteer to use dynamic ingestion.');
    }
  }
}

async function loadDynamicPage(url, {
  browser = null,
  waitUntil = 'networkidle',
  timeoutMs = 60_000,
  settleMs = 750,
} = {}) {
  const driver = browser ? null : getBrowserDriver();
  let launchedBrowser = browser;

  if (!launchedBrowser) {
    if (driver.kind === 'playwright') {
      launchedBrowser = await driver.module.chromium.launch({ headless: true });
    } else {
      launchedBrowser = await driver.module.launch({ headless: true });
    }
  }

  const page = await launchedBrowser.newPage();
  try {
    if (driver && driver.kind === 'playwright') {
      await page.goto(url, { waitUntil, timeout: timeoutMs });
    } else {
      await page.goto(url, { waitUntil, timeout: timeoutMs });
    }

    if (typeof page.waitForNetworkIdle === 'function') {
      await page.waitForNetworkIdle({ idleTime: settleMs, timeout: timeoutMs }).catch(() => {});
    } else if (typeof page.waitForTimeout === 'function') {
      await page.waitForTimeout(settleMs);
    }

    const renderedText = typeof page.evaluate === 'function'
      ? await page.evaluate(() => document.body && document.body.innerText ? document.body.innerText : '')
      : '';
    const rawHtml = typeof page.content === 'function' ? await page.content() : '';
    return {
      url,
      rawHtml,
      text: normalizeText(renderedText || stripHtml(rawHtml)),
    };
  } finally {
    if (!browser && launchedBrowser && typeof launchedBrowser.close === 'function') {
      await launchedBrowser.close();
    } else if (page && typeof page.close === 'function') {
      await page.close();
    }
  }
}

async function ingestDynamicPage(input, options = {}) {
  const loaded = await loadDynamicPage(input.sourceUrl || input.url, options);
  return bulletin.ingestBulletin({
    state: input.state,
    sourceType: input.sourceType || input.source_type || 'bulletin',
    sourceUrl: input.sourceUrl || input.url,
    sourceName: input.sourceName || input.source_name || '',
    text: bulletin.cleanBulletinText(loaded.text),
    rawHtml: loaded.rawHtml,
    rawPayload: {
      mode: 'dynamic',
      url: loaded.url,
    },
  });
}

module.exports = {
  stripHtml,
  getBrowserDriver,
  loadDynamicPage,
  ingestDynamicPage,
};
