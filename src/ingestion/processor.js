'use strict';

const db = require('../db/pg');
const { resolveOpenRouter, callOpenRouter } = require('./openai-compatible-client');
const { sha256Fingerprint } = require('./ingestion_guard');
const { extractCounty, slugifyCounty } = require('../lib/county-extractor');

function buildClaudeSystemPrompt() {
  return [
    'You write daily plain-language summaries of public records for blotter.host.',
    'Be neutral, factual, and restrained.',
    'Do not repeat unverified accusations, speculation, rumors, or editorialized language.',
    'Do not infer guilt, intent, or motive unless the source record explicitly and clearly states it.',
    'If a detail is ambiguous or unverified, omit it or state that the source record does not confirm it.',
    'Return ONLY valid JSON with exactly these keys: headline, body_html, source_type, categories, county.',
    'headline must be a short plain-language headline.',
    'body_html must be HTML-safe body content using simple tags only, suitable for rendering directly.',
    'source_type must echo the source type provided in the input.',
    'categories must be an array of 1 to 3 short topic tags (e.g., ["crime", "public safety", "courts"]).',
    'county must be the name of the US county most associated with the record, without the word "County" (e.g., "Ada" or "Los Angeles"). Omit the key if no county is identifiable.',
    'Do not wrap the JSON in markdown fences or any extra commentary.',
  ].join(' ');
}

function normalizeHeadline(headline) {
  return String(headline || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function headlineFingerprint(headline) {
  return sha256Fingerprint(normalizeHeadline(headline));
}

function normalizeCategories(categories) {
  if (!Array.isArray(categories)) return [];
  return categories
    .map((c) => String(c || '').trim().toLowerCase())
    .filter((c) => c.length > 0 && c.length <= 50)
    .slice(0, 5);
}

function resolveContentFingerprintWindowDays() {
  const raw = String(process.env.CONTENT_FINGERPRINT_WINDOW_DAYS || '').trim();
  if (!raw) return 30;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function normalizeArticleContent(headline, bodyHtml) {
  const combined = `${String(headline || '')}\n${stripHtml(bodyHtml)}`;
  return combined
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function contentFingerprint(headline, bodyHtml) {
  return sha256Fingerprint(normalizeArticleContent(headline, bodyHtml));
}

function resolveAnthropicClient() {
  // deprecated: still exported for callers that explicitly want Anthropic
  let Anthropic;
  try {
    ({ Anthropic } = require('@anthropic-ai/sdk'));
  } catch (err) {
    throw new Error(
      'Anthropic SDK is not installed. Add @anthropic-ai/sdk to package.json and install dependencies.'
    );
  }

  const apiKey = String(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_TOKEN || '').trim();
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required to prepare Claude requests.');
  }

  return new Anthropic({ apiKey });
}

function resolveLLMClient() {
  const lookup = resolveOpenRouter();
  if (lookup) {
    const invoke = callOpenRouter.bind(null, lookup);
    return {
      provider: 'openrouter',
      ...lookup,
      messages: {
        create: async ({ system, messages }) => {
          const result = await invoke({ system, messages });
          const text = result && typeof result.content === 'string' ? result.content : '';
          return {
            content: [{ text }],
          };
        },
      },
    };
  }

  throw new Error(
    'No LLM client configured. Set OPENROUTER_API_KEY, or set ANTHROPIC_API_KEY and install @anthropic-ai/sdk.'
  );
}

async function fetchUnprocessedRecords(limit = 10, { queryFn = db.adminQuery } = {}) {
  const cap = Math.max(1, Math.min(10, parseInt(limit, 10) || 10));
  const result = await queryFn(
    `
      SELECT
        rr.id,
        rr.state,
        rr.source_type,
        rr.source_url,
        rr.source_name,
        rr.fingerprint,
        rr.raw_text,
        rr.raw_html,
        rr.raw_payload,
        rr.created_at
      FROM raw_records rr
      LEFT JOIN generated_articles ga ON ga.raw_record_id = rr.id
      WHERE rr.processed_at IS NULL
        AND ga.id IS NULL
      ORDER BY rr.created_at ASC, rr.id ASC
      LIMIT $1
    `,
    [cap]
  );

  if (!result.ok) {
    throw new Error(result.error || 'failed to fetch unprocessed raw_records');
  }

  return result.rows;
}

function buildClaudeMessages(record) {
  const state = String(record.state || '').trim();
  const sourceType = String(record.source_type || record.sourceType || '').trim();
  const sourceUrl = String(record.source_url || record.sourceUrl || '').trim();
  const sourceName = String(record.source_name || record.sourceName || '').trim();
  const rawText = String(record.raw_text || record.rawText || '').trim();
  const countyHint = extractCounty(rawText);

  return [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            'You are preparing a plain-language public safety summary for blotter.host.',
            `State: ${state}`,
            `Source type: ${sourceType}`,
            `Source name: ${sourceName || 'Unknown'}`,
            `Source URL: ${sourceUrl}`,
            countyHint ? `Likely county (verify): ${countyHint.name}` : '',
            '',
            'Raw record:',
            rawText,
          ].join('\n'),
        },
      ],
    },
  ];
}

function buildClaudePrompt(record) {
  const messages = buildClaudeMessages(record);
  return {
    model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest',
    max_tokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS, 10) || 1200,
    temperature: 0.2,
    system: buildClaudeSystemPrompt(),
    messages,
  };
}

function parseClaudeResponse(response) {
  const text = String(
    response &&
    response.content &&
    response.content[0] &&
    response.content[0].text
      ? response.content[0].text
      : ''
  ).trim();

  if (!text) {
    throw new Error('Claude returned an empty response');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Claude response was not valid JSON: ${err.message}`);
  }

  const headline = String(parsed.headline || '').trim();
  const bodyHtml = String(parsed.body_html || '').trim();
  const sourceType = String(parsed.source_type || '').trim();
  const categories = normalizeCategories(parsed.categories);
  const county = String(parsed.county || '').trim();

  if (!headline || !bodyHtml || !sourceType) {
    throw new Error('Claude JSON must include headline, body_html, and source_type');
  }

  return {
    headline,
    body_html: bodyHtml,
    source_type: sourceType,
    categories,
    county_slug: county ? slugifyCounty(county) : null,
  };
}

async function findArticleByHeadlineFingerprint(state, fingerprint, { queryFn = db.adminQuery } = {}) {
  if (!state || !fingerprint) return null;
  const result = await queryFn(
    'SELECT id FROM generated_articles WHERE state = $1 AND headline_fingerprint = $2 LIMIT 1',
    [state, fingerprint]
  );
  if (!result.ok) {
    throw new Error(result.error || 'headline fingerprint lookup failed');
  }
  return result.rows[0] || null;
}

async function findArticleByContentFingerprint(
  state,
  fingerprint,
  { queryFn = db.adminQuery, windowDays = null } = {}
) {
  if (!state || !fingerprint) return null;
  const days = Number.isFinite(windowDays) && windowDays >= 0
    ? windowDays
    : resolveContentFingerprintWindowDays();
  const result = await queryFn(
    `SELECT id FROM generated_articles
     WHERE state = $1
       AND created_at > NOW() - make_interval(days => $2)
     ORDER BY created_at DESC`,
    [state, days]
  );
  if (!result.ok) {
    throw new Error(result.error || 'content fingerprint lookup failed');
  }
  // Compare fingerprints in JS because we compute them from normalized headline+body,
  // which is not stored in its own column yet.
  for (const row of result.rows) {
    const existingFingerprint = contentFingerprint(row.headline || '', row.body || '');
    if (existingFingerprint === fingerprint) return row;
  }
  return null;
}

async function insertGeneratedArticle(record, article, { queryFn = db.adminQuery } = {}) {
  const fingerprint = headlineFingerprint(article.headline);
  const duplicate = await findArticleByHeadlineFingerprint(record.state, fingerprint, { queryFn });
  if (duplicate) {
    return {
      skipped: true,
      duplicate: true,
      reason: 'headline_fingerprint',
      existing_generated_article_id: duplicate.id,
      headline_fingerprint: fingerprint,
    };
  }

  const contentFp = contentFingerprint(article.headline, article.body_html);
  const contentDuplicate = await findArticleByContentFingerprint(record.state, contentFp, { queryFn });
  if (contentDuplicate) {
    return {
      skipped: true,
      duplicate: true,
      reason: 'content_fingerprint',
      existing_generated_article_id: contentDuplicate.id,
      headline_fingerprint: fingerprint,
      content_fingerprint: contentFp,
    };
  }

  const categoriesJson = Array.isArray(article.categories) && article.categories.length
    ? JSON.stringify(article.categories)
    : null;

  const result = await queryFn(
    `
      INSERT INTO generated_articles (
        raw_record_id,
        state,
        county,
        headline,
        headline_fingerprint,
        body,
        categories,
        publication_status,
        published_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING id
    `,
    [
      record.id,
      record.state,
      article.county_slug || null,
      article.headline,
      fingerprint,
      article.body_html,
      categoriesJson,
      'draft',
    ]
  );

  if (!result.ok) {
    throw new Error(result.error || 'generated_articles insert failed');
  }

  return {
    skipped: false,
    duplicate: false,
    generated_article_id: result.rows[0] ? result.rows[0].id : null,
    headline_fingerprint: fingerprint,
    content_fingerprint: contentFp,
  };
}

async function markRawRecordProcessed(rawRecordId, { queryFn = db.adminQuery } = {}) {
  const result = await queryFn(
    `
      UPDATE raw_records
      SET processed_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING id
    `,
    [rawRecordId]
  );

  if (!result.ok) {
    throw new Error(result.error || 'failed to mark raw_record processed');
  }

  return result.rows[0] ? result.rows[0].id : null;
}

async function prepareRecordsForClaude(limit = 10, options = {}) {
  const records = options.records || await fetchUnprocessedRecords(limit, options);
  const prompts = records.map((record) => ({
    raw_record_id: record.id,
    state: record.state,
    source_type: record.source_type,
    source_url: record.source_url,
    prompt: buildClaudePrompt(record),
  }));

  return {
    ok: true,
    count: prompts.length,
    records: prompts,
  };
}

async function processRecordsWithClaude(limit = 10, options = {}) {
  const client = options.client || resolveLLMClient();
  const prepared = await prepareRecordsForClaude(limit, options);
  const results = [];

  for (const item of prepared.records) {
    try {
      const response = await client.messages.create(item.prompt);
      const article = parseClaudeResponse(response);
      const insertResult = await insertGeneratedArticle(
        {
          id: item.raw_record_id,
          state: item.state,
        },
        article,
        options
      );
      await markRawRecordProcessed(item.raw_record_id, options);
      results.push({
        raw_record_id: item.raw_record_id,
        state: item.state,
        source_type: article.source_type,
        source_url: item.source_url,
        generated_article_id: insertResult.generated_article_id || null,
        existing_generated_article_id: insertResult.existing_generated_article_id || null,
        duplicate: insertResult.duplicate || false,
        reason: insertResult.reason || null,
        headline_fingerprint: insertResult.headline_fingerprint || null,
        content_fingerprint: insertResult.content_fingerprint || null,
        article,
      });
    } catch (err) {
      results.push({
        raw_record_id: item.raw_record_id,
        state: item.state,
        source_type: item.source_type,
        source_url: item.source_url,
        error: err.message,
      });
    }
  }

  return {
    ok: true,
    count: results.length,
    results,
  };
}

module.exports = {
  resolveAnthropicClient,
  buildClaudeSystemPrompt,
  normalizeHeadline,
  headlineFingerprint,
  normalizeCategories,
  resolveContentFingerprintWindowDays,
  stripHtml,
  normalizeArticleContent,
  contentFingerprint,
  fetchUnprocessedRecords,
  buildClaudeMessages,
  buildClaudePrompt,
  parseClaudeResponse,
  findArticleByHeadlineFingerprint,
  findArticleByContentFingerprint,
  insertGeneratedArticle,
  markRawRecordProcessed,
  prepareRecordsForClaude,
  processRecordsWithClaude,
};
