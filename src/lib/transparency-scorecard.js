'use strict';

/**
 * transparency-scorecard.js
 *
 * Lightweight scoring for state/county transparency based purely on published
 * blotter data. No manual registry is required, so it works the moment articles
 * start flowing in.
 *
 * Metrics:
 *   coverage   — share of counties in the state with >=1 published article.
 *   freshness  — share of articles in the window published within 7 days.
 *   diversity  — distinct source_types observed.
 *   velocity   — average articles per day over the last 30 days.
 *   recency    — days since the most recent article (lower is better).
 */

const db = require('../db/pg');

const WINDOW_DAYS = 90;
const FRESH_DAYS = 7;

function daysAgoISO(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

async function scoreState(stateSlug, stateCode) {
  const state = String(stateSlug || '').toLowerCase();
  const code = String(stateCode || stateSlug || '').toUpperCase();
  if (!state || !code) return null;

  const since90 = daysAgoISO(WINDOW_DAYS);

  const countySql = `
    SELECT DISTINCT county
      FROM generated_articles
     WHERE state = $1 AND county IS NOT NULL
       AND publication_status = 'published'
  `;
  const articleSql = `
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE created_at > $2) AS fresh,
      COUNT(DISTINCT source_type) AS source_types,
      COUNT(DISTINCT county) AS counties_covered,
      MAX(created_at) AS most_recent,
      COUNT(*) FILTER (WHERE created_at > $3) / 30.0 AS velocity_30d
    FROM generated_articles ga
    LEFT JOIN raw_records rr ON rr.id = ga.raw_record_id
    WHERE ga.state = $1
      AND ga.publication_status = 'published'
      AND ga.created_at > $2
  `;

  const [countyResult, articleResult] = await Promise.all([
    db.tenantQuery(code, countySql, [state]),
    db.tenantQuery(code, articleSql, [state, since90, daysAgoISO(30)]),
  ]);

  if (!countyResult.ok || !articleResult.ok || !articleResult.rows.length) {
    return buildScorecard(state, [], { total: 0 });
  }

  const counties = countyResult.ok ? countyResult.rows.map((r) => r.county) : [];
  return buildScorecard(state, counties, articleResult.rows[0]);
}

async function scoreCounty(stateSlug, countySlug, stateCode) {
  const state = String(stateSlug || '').toLowerCase();
  const county = String(countySlug || '').toLowerCase();
  const code = String(stateCode || stateSlug || '').toUpperCase();
  if (!state || !county || !code) return null;

  const since90 = daysAgoISO(WINDOW_DAYS);

  const articleSql = `
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE created_at > $3) AS fresh,
      COUNT(DISTINCT source_type) AS source_types,
      MAX(created_at) AS most_recent,
      COUNT(*) FILTER (WHERE created_at > $4) / 30.0 AS velocity_30d
    FROM generated_articles ga
    LEFT JOIN raw_records rr ON rr.id = ga.raw_record_id
    WHERE ga.state = $1
      AND ga.county = $2
      AND ga.publication_status = 'published'
      AND ga.created_at > $3
  `;

  const result = await db.tenantQuery(code, articleSql, [state, county, since90, daysAgoISO(30)]);
  if (!result.ok || !result.rows.length) {
    return buildCountyScorecard(state, county, { total: 0 });
  }
  return buildCountyScorecard(state, county, result.rows[0]);
}

function buildScorecard(state, counties, row) {
  const total = parseInt(row.total || 0, 10);
  const countiesCovered = parseInt(row.counties_covered || 0, 10);
  const countyCount = counties.length || countiesCovered || 0;

  let coverage = 0;
  if (countyCount > 0 && total > 0) {
    coverage = (countiesCovered / countyCount) * 100;
  }

  let freshness = 0;
  if (total > 0) {
    freshness = (parseInt(row.fresh || 0, 10) / total) * 100;
  }

  const sourceTypes = parseInt(row.source_types || 0, 10);
  const diversity = clampScore(sourceTypes * 25); // 4+ types = 100

  const velocity = parseFloat(row.velocity_30d || 0);
  const velocityScore = clampScore(velocity * 10); // 10/day = 100

  const mostRecent = row.most_recent instanceof Date
    ? row.most_recent.toISOString()
    : row.most_recent;
  const daysSince = mostRecent
    ? Math.floor((Date.now() - new Date(mostRecent).getTime()) / (24 * 60 * 60 * 1000))
    : null;
  const recencyScore = daysSince === null ? 0 : clampScore(100 - daysSince * 10);

  const overall = clampScore((coverage * 0.3) + (freshness * 0.2) + (diversity * 0.15) + (velocityScore * 0.15) + (recencyScore * 0.2));

  return {
    state,
    level: 'state',
    overall,
    breakdown: {
      coverage: clampScore(coverage),
      freshness: clampScore(freshness),
      diversity,
      velocity: velocityScore,
      recency: recencyScore,
    },
    counts: {
      totalArticles: total,
      countiesCovered,
      totalCounties: countyCount,
      sourceTypes,
      velocity,
      daysSinceLastArticle: daysSince,
    },
    windowDays: WINDOW_DAYS,
  };
}

function buildCountyScorecard(state, county, row) {
  const total = parseInt(row.total || 0, 10);
  const freshness = total > 0 ? (parseInt(row.fresh || 0, 10) / total) * 100 : 0;
  const sourceTypes = parseInt(row.source_types || 0, 10);
  const diversity = clampScore(sourceTypes * 25);
  const velocity = parseFloat(row.velocity_30d || 0);
  const velocityScore = clampScore(velocity * 10);
  const mostRecent = row.most_recent instanceof Date
    ? row.most_recent.toISOString()
    : row.most_recent;
  const daysSince = mostRecent
    ? Math.floor((Date.now() - new Date(mostRecent).getTime()) / (24 * 60 * 60 * 1000))
    : null;
  const recencyScore = daysSince === null ? 0 : clampScore(100 - daysSince * 10);
  const overall = clampScore((freshness * 0.3) + (diversity * 0.2) + (velocityScore * 0.25) + (recencyScore * 0.25));

  return {
    state,
    county,
    level: 'county',
    overall,
    breakdown: {
      freshness: clampScore(freshness),
      diversity,
      velocity: velocityScore,
      recency: recencyScore,
    },
    counts: {
      totalArticles: total,
      sourceTypes,
      velocity,
      daysSinceLastArticle: daysSince,
    },
    windowDays: WINDOW_DAYS,
  };
}

module.exports = { scoreState, scoreCounty, WINDOW_DAYS, FRESH_DAYS };
