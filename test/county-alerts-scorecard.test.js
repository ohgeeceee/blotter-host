'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractCounty, slugifyCounty, titleizeCounty } = require('../src/lib/county-extractor');
const { scoreState, scoreCounty, WINDOW_DAYS } = require('../src/lib/transparency-scorecard');
const { buildDigestHtml } = require('../scripts/send-alert-digest');
const pg = require('../src/db/pg');

test('county extractor finds and normalizes county names', () => {
  const text = 'Deputies in King County responded to a call near Snohomish County line.';
  const result = extractCounty(text);
  assert.equal(result.slug, 'king');
});

test('county extractor ranks by first occurrence', () => {
  const text = 'Pierce County saw snow; King County had rain. Later, Pierce County flooded.';
  const result = extractCounty(text);
  assert.equal(result.slug, 'pierce');
});

test('county slugify and titleize are inverses', () => {
  assert.equal(slugifyCounty('San Mateo County'), 'san-mateo');
  assert.equal(titleizeCounty('san-mateo'), 'San Mateo');
});

test('scoreState returns empty scorecard when no articles', async () => {
  const original = pg.tenantQuery;
  pg.tenantQuery = async (stateCode, sql) => {
    if (/SELECT DISTINCT county/.test(sql)) {
      return { ok: true, rows: [], rowCount: 0 };
    }
    return { ok: true, rows: [{ total: 0, fresh: 0, source_types: 0, counties_covered: 0, most_recent: null, velocity_30d: 0 }], rowCount: 1 };
  };

  try {
    const s = await scoreState('washington', 'WA');
    assert.equal(s.level, 'state');
    assert.equal(s.state, 'washington');
    assert.equal(s.counts.totalArticles, 0);
    assert.equal(s.overall, 0);
  } finally {
    pg.tenantQuery = original;
  }
});

test('scoreState computes breakdown and overall grade', async () => {
  const original = pg.tenantQuery;
  pg.tenantQuery = async (stateCode, sql) => {
    if (/SELECT DISTINCT county/.test(sql)) {
      return { ok: true, rows: [{ county: 'king' }, { county: 'pierce' }], rowCount: 2 };
    }
    return {
      ok: true,
      rows: [{
        total: '40',
        fresh: '28',
        source_types: '3',
        counties_covered: '2',
        most_recent: new Date(Date.now() - 24 * 60 * 60 * 1000),
        velocity_30d: '2.5',
      }],
      rowCount: 1,
    };
  };

  try {
    const s = await scoreState('washington', 'WA');
    assert.equal(s.level, 'state');
    assert.equal(s.breakdown.coverage, 100);
    assert.equal(s.breakdown.freshness, 70);
    assert.equal(s.breakdown.diversity, 75);
    assert.equal(s.counts.totalArticles, 40);
    assert.ok(s.overall > 0);
  } finally {
    pg.tenantQuery = original;
  }
});

test('scoreCounty omits coverage metric', async () => {
  const original = pg.tenantQuery;
  pg.tenantQuery = async (stateCode, sql) => ({
    ok: true,
    rows: [{
      total: '12',
      fresh: '6',
      source_types: '2',
      most_recent: new Date(Date.now() - 48 * 60 * 60 * 1000),
      velocity_30d: '0.4',
    }],
    rowCount: 1,
  });

  try {
    const s = await scoreCounty('washington', 'king', 'WA');
    assert.equal(s.level, 'county');
    assert.equal(s.county, 'king');
    assert.equal(s.breakdown.freshness, 50);
    assert.ok(!('coverage' in s.breakdown));
  } finally {
    pg.tenantQuery = original;
  }
});

test('buildDigestHtml returns null when no matches', () => {
  const html = buildDigestHtml({ email: 'a@example.test' }, []);
  assert.equal(html, null);
});

test('buildDigestHtml renders reader digest with links', () => {
  const html = buildDigestHtml(
    { email: 'a@example.test', id: 1 },
    [{
      alert: { id: 1, alert_type: 'county', target: 'king' },
      matches: [{
        id: 42,
        state: 'washington',
        county: 'king',
        headline: 'Test headline',
        body: '<p>Test body content.</p>',
        created_at: new Date().toISOString(),
      }],
    }]
  );
  assert.match(String(html), /Test headline/);
  assert.match(String(html), /washington.blotter.host\/blotter\/42/);
});

test('window constant is 90 days', () => {
  assert.equal(WINDOW_DAYS, 90);
});
