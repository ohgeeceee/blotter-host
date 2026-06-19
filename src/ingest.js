'use strict';

const path = require('node:path');
require('./lib/load-env').loadEnvFile(path.join(__dirname, '..', '.env'));

const { scrapeStaticPage } = require('./ingestion/static_scraper');
const { scrapeDynamicPage } = require('./ingestion/playwright_scraper');
const {
  buildFailurePayload,
  normalizeText,
  runGuarded,
  sha256Fingerprint,
} = require('./ingestion/ingestion_guard');
const {
  fingerprintExists,
  insertRawRecord,
} = require('./ingestion/postgres');

function buildParser() {
  return {
    parseArgs(argv) {
      return parseArgs(argv);
    },
  };
}

function parseArgs(argv) {
  const args = {
    state: '',
    sourceType: '',
    sourceUrl: '',
    sourceName: '',
    mode: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--state') args.state = String(next || '').trim(), i += 1;
    else if (token === '--source-type') args.sourceType = String(next || '').trim(), i += 1;
    else if (token === '--source-url') args.sourceUrl = String(next || '').trim(), i += 1;
    else if (token === '--source-name') args.sourceName = String(next || '').trim(), i += 1;
    else if (token === '--mode') args.mode = String(next || '').trim(), i += 1;
  }

  return args;
}

async function ingestOne(source, deps = {}) {
  const scrapeStatic = deps.scrapeStaticPage || scrapeStaticPage;
  const scrapeDynamic = deps.scrapeDynamicPage || scrapeDynamicPage;
  const exists = deps.fingerprintExists || fingerprintExists;
  const insert = deps.insertRawRecord || insertRawRecord;
  const guarded = deps.runGuarded || runGuarded;
  const fingerprintFn = deps.sha256Fingerprint || sha256Fingerprint;
  const normalize = deps.normalizeText || normalizeText;

  const details = {
    state: source.state,
    sourceType: source.sourceType,
    sourceName: source.sourceName,
    sourceUrl: source.sourceUrl,
  };

  return guarded(async () => {
    const result = source.mode === 'playwright'
      ? await scrapeDynamic(source.sourceUrl)
      : await scrapeStatic(source.sourceUrl);

    const fingerprint = fingerprintFn(result.text);
    if (await exists(fingerprint)) {
      return {
        ok: true,
        status: 'duplicate_skipped',
        fingerprint,
      };
    }

    const inserted = await insert({
      state: source.state,
      sourceType: source.sourceType,
      sourceUrl: source.sourceUrl,
      sourceName: source.sourceName,
      fingerprint,
      rawText: normalize(result.text),
      rawHtml: result.rawHtml,
      rawPayload: {
        mode: source.mode,
      },
    });

    return {
      ok: true,
      status: inserted.inserted ? 'inserted' : 'duplicate_skipped',
      fingerprint,
      id: inserted.id,
    };
  }, details);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.state || !args.sourceType || !args.sourceUrl || !args.mode) {
    throw new Error('Usage: node src/ingest.js --state <slug> --source-type <type> --source-url <url> --mode <static|playwright>');
  }

    const result = await ingestOne({
      state: args.state,
      sourceType: args.sourceType,
      sourceUrl: args.sourceUrl,
      sourceName: args.sourceName || '',
      mode: args.mode,
    });

  if (!result.ok) {
    process.stderr.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = 1;
    return result;
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (require.main === module) {
  main().catch((err) => {
    const payload = buildFailurePayload({
      state: '',
      sourceType: '',
      sourceName: '',
      sourceUrl: '',
      errorType: err.name,
      errorMessage: err.message,
      stackTrace: err.stack,
    });
    process.stderr.write(JSON.stringify(payload, null, 2) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  buildParser,
  parseArgs,
  ingestOne,
  main,
};
