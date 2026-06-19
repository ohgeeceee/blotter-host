'use strict';

/**
 * state-public.js — Tenant Surface (public-facing state site)
 * -----------------------------------------------------------
 * Mounted only when req.isRootAdmin is FALSE (i.e. the host is a known
 * <slug>.blotter.host). The middleware has already populated:
 *
 *   req.isRootAdmin   false
 *   req.stateContext  'WA'  (uppercase 2-letter code)
 *   req.tenant        frozen registry entry
 *
 * All data lookups for this surface must go through db.tenantQuery() with
 * req.stateContext so the RLS policy scopes the result to this state.
 *
 * Routes:
 *
 *   GET /                  tenant landing (the state hero + recent blotters)
 *   GET /healthz           surface check
 *   GET /api/state/info    public state metadata (no PII)
 *   GET /api/blotters      recent blotters, paginated
 *   GET /blotter/:id       single blotter detail
 *
 * The previous state.js used src/render/context.js directly; this router
 * uses the new pipeline so theme, SEO, and bail-bond overrides apply.
 */

const express = require('express');
const { renderForState } = require('../render/pipeline');
const db = require('../db/pg');
const { capitalize, ROOT_DOMAIN } = require('../middleware/subdomain');
const { scoreState, scoreCounty } = require('../lib/transparency-scorecard');

const router = express.Router();

const ROOT_PAGES = new Set(['about', 'methodology', 'corrections', 'subscribe']);

for (const page of ROOT_PAGES) {
  router.get(`/${page}`, (_req, res) => {
    res.redirect(301, `https://${ROOT_DOMAIN}/${page}`);
  });
}

router.get('/archive', (_req, res) => {
  res.redirect(301, '/');
});

function titleizeSlug(value) {
  return String(value || '')
    .trim()
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const BLOTTER_LIST_SQL_BASE = `
  SELECT
    ga.id           AS id,
    ga.state        AS state,
    ga.county       AS county,
    ga.headline     AS title,
    ga.body         AS summary,
    ga.created_at   AS published_at,
    rr.source_type  AS source_type,
    rr.source_name  AS agency
  FROM generated_articles ga
  LEFT JOIN raw_records rr ON rr.id = ga.raw_record_id
  WHERE ga.state = $2
`;

const BLOTTER_DETAIL_SQL = `
  SELECT
    ga.id,
    ga.state,
    ga.county,
    ga.headline AS title,
    ga.body AS summary,
    ga.created_at AS published_at,
    rr.source_name AS agency,
    rr.raw_text
  FROM generated_articles ga
  LEFT JOIN raw_records rr ON rr.id = ga.raw_record_id
  WHERE ga.id = $1
  LIMIT 1
`;

/**
 * GET / — state hero + recent blotters.
 */
router.get('/', async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 10));
    const filterStateSlug = String(
      req.subdomain
      || (req.tenant && req.tenant.slug)
      || ''
    ).toLowerCase();
    const sourceType = String(req.query.category || '').trim();
    const countySlug = String(req.query.county || '').trim().toLowerCase();

    let sql = BLOTTER_LIST_SQL_BASE;
    const params = [limit, filterStateSlug];
    let paramIdx = 3;
    if (sourceType) {
      sql += ` AND rr.source_type = $${paramIdx}`;
      params.push(sourceType);
      paramIdx += 1;
    }
    if (countySlug) {
      sql += ` AND ga.county = $${paramIdx}`;
      params.push(countySlug);
      paramIdx += 1;
    }
    sql += ' ORDER BY ga.created_at DESC, ga.id ASC LIMIT $1';

    const [result, countyOptionsResult] = await Promise.all([
      db.tenantQuery(req.stateContext, sql, params),
      db.tenantQuery(req.stateContext, `
        SELECT DISTINCT county
          FROM generated_articles
         WHERE state = $1 AND county IS NOT NULL
         ORDER BY county
      `, [filterStateSlug]),
    ]);

    const countyOptions = countyOptionsResult.ok ? countyOptionsResult.rows.map((r) => r.county) : [];

    const blotters = result.ok
      ? result.rows.map((r) => ({
          id: r.id,
          title: r.title,
          summary: r.summary,
          county: r.county,
          agency: r.agency,
          sourceType: r.source_type,
          date: r.published_at instanceof Date
            ? r.published_at.toISOString().slice(0, 10)
            : r.published_at,
        }))
      : [];

    const stateSlug = req.subdomain || (req.tenant && req.tenant.slug) || '';
    const stateName = (req.tenant && req.tenant.name && String(req.tenant.name).trim())
      || titleizeSlug(stateSlug)
      || titleizeSlug(req.stateContext);
    const tenant = Object.assign({}, req.tenant || {}, {
      slug: stateSlug,
      code: req.stateContext || (req.tenant && req.tenant.code) || '',
      name: stateName,
    });

    const html = renderForState(tenant, 'state/index.html', {
      REQUEST_HOST: req.headers.host,
      REQUEST_PATH: req.path,
      BLOTTER_DATA: blotters,
      BLOTTER_LIST_HTML: renderBlotterListHtml(blotters),
      ACTIVE_CATEGORY: sourceType,
      ACTIVE_COUNTY: countySlug,
      CATEGORY_FILTER_HTML: renderCategoryFilterHtml(sourceType),
      COUNTY_FILTER_HTML: renderCountyFilterHtml(countyOptions, countySlug),
      DB_OK: result.ok ? '1' : '0',
    });
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

function renderBlotterListHtml(blotters) {
  if (!blotters.length) {
    return '<li class="blotter-item blotter-item--empty">No blotters published yet. Check back soon.</li>';
  }
  return blotters.map((b) => `
    <li class="blotter-item">
      <a class="blotter-item__link" href="/blotter/${b.id}">
        <span class="blotter-item__date">${formatHumanDate(b.date)}</span>
        <span class="blotter-item__title">${b.title}</span>
      </a>
      ${b.county ? `<p class="blotter-item__county"><a href="/county/${encodeURIComponent(b.county)}">${titleizeSlug(b.county)} County</a></p>` : ''}
      ${b.sourceType ? `<p class="blotter-item__category">${formatCategoryLabel(b.sourceType)}</p>` : ''}
      <p class="blotter-item__summary">${b.summary}</p>
    </li>
  `).join('');
}

function renderCountyFilterHtml(counties, active) {
  if (!counties.length) {
    return '<nav class="county-filter" aria-label="Filter by county"></nav>';
  }
  const buttons = counties.map((slug) => {
    const isActive = slug === active;
    const cls = isActive ? 'county-filter__chip county-filter__chip--active' : 'county-filter__chip';
    return `<a class="${cls}" href="/?county=${encodeURIComponent(slug)}">${titleizeSlug(slug)}</a>`;
  });
  buttons.unshift(`<a class="county-filter__chip${active ? '' : ' county-filter__chip--active'}" href="/">All counties</a>`);
  return `<nav class="county-filter" aria-label="Filter by county">${buttons.join('')}</nav>`;
}

const CATEGORY_OPTIONS = [
  { value: '', label: 'All sources' },
  { value: 'news_bulletin', label: 'News' },
  { value: 'police_blotter', label: 'Police blotter' },
  { value: 'jail_roster', label: 'Jail roster' },
  { value: 'bulletin', label: 'Bulletin' },
];

function formatCategoryLabel(slug) {
  return String(slug || '')
    .split('_')
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

function renderCategoryFilterHtml(active) {
  const buttons = CATEGORY_OPTIONS.map((opt) => {
    const isActive = opt.value === active;
    const cls = isActive ? 'blotter-filter__chip blotter-filter__chip--active' : 'blotter-filter__chip';
    const href = opt.value ? `?category=${encodeURIComponent(opt.value)}` : '/';
    return `<a class="${cls}" href="${href}">${opt.label}</a>`;
  }).join('');
  return `<nav class="blotter-filter" aria-label="Filter by source category">${buttons}</nav>`;
}

function formatHumanDate(iso) {
  if (typeof iso !== 'string') return iso;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[parseInt(m[2], 10) - 1] || m[2];
  return `${month} ${parseInt(m[3], 10)}, ${m[1]}`;
}

/**
 * GET /county/:countySlug — county blotter listing.
 */
router.get('/county/:countySlug', async (req, res, next) => {
  try {
    const countySlug = String(req.params.countySlug || '').trim().toLowerCase();
    if (!countySlug) {
      return res.status(404).type('html').send('County not found.');
    }

    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 25));
    const filterStateSlug = String(
      req.subdomain
      || (req.tenant && req.tenant.slug)
      || ''
    ).toLowerCase();

    const sql = `${BLOTTER_LIST_SQL_BASE} AND ga.county = $3 ORDER BY ga.created_at DESC, ga.id ASC LIMIT $1`;
    const result = await db.tenantQuery(req.stateContext, sql, [limit, filterStateSlug, countySlug]);

    const blotters = result.ok
      ? result.rows.map((r) => ({
          id: r.id,
          title: r.title,
          summary: r.summary,
          county: r.county,
          agency: r.agency,
          sourceType: r.source_type,
          date: r.published_at instanceof Date
            ? r.published_at.toISOString().slice(0, 10)
            : r.published_at,
        }))
      : [];

    const stateSlug = req.subdomain || (req.tenant && req.tenant.slug) || '';
    const stateName = (req.tenant && req.tenant.name && String(req.tenant.name).trim())
      || titleizeSlug(stateSlug)
      || titleizeSlug(req.stateContext);
    const tenant = Object.assign({}, req.tenant || {}, {
      slug: stateSlug,
      code: req.stateContext || (req.tenant && req.tenant.code) || '',
      name: stateName,
    });

    const html = renderForState(tenant, 'state/county.html', {
      REQUEST_HOST: req.headers.host,
      REQUEST_PATH: req.path,
      COUNTY_NAME: titleizeSlug(countySlug),
      COUNTY_SLUG: countySlug,
      BLOTTER_DATA: blotters,
      BLOTTER_LIST_HTML: renderBlotterListHtml(blotters),
      DB_OK: result.ok ? '1' : '0',
    });
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /transparency — state transparency scorecard.
 */
router.get('/transparency', async (req, res, next) => {
  try {
    const stateSlug = String(
      req.subdomain
      || (req.tenant && req.tenant.slug)
      || ''
    ).toLowerCase();
    const stateName = (req.tenant && req.tenant.name && String(req.tenant.name).trim())
      || titleizeSlug(stateSlug)
      || titleizeSlug(req.stateContext);
    const tenant = Object.assign({}, req.tenant || {}, {
      slug: stateSlug,
      code: req.stateContext || (req.tenant && req.tenant.code) || '',
      name: stateName,
    });

    const scorecard = await scoreState(stateSlug, req.stateContext);

    const html = renderForState(tenant, 'state/transparency.html', {
      REQUEST_HOST: req.headers.host,
      REQUEST_PATH: req.path,
      STATE_NAME: stateName,
      SCORECARD_JSON: JSON.stringify(scorecard || {}),
      SCORECARD_HTML: renderScorecardHtml(scorecard),
    });
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /county/:countySlug/transparency — county transparency scorecard.
 */
router.get('/county/:countySlug/transparency', async (req, res, next) => {
  try {
    const countySlug = String(req.params.countySlug || '').trim().toLowerCase();
    if (!countySlug) {
      return res.status(404).type('html').send('County not found.');
    }

    const stateSlug = String(
      req.subdomain
      || (req.tenant && req.tenant.slug)
      || ''
    ).toLowerCase();
    const stateName = (req.tenant && req.tenant.name && String(req.tenant.name).trim())
      || titleizeSlug(stateSlug)
      || titleizeSlug(req.stateContext);
    const tenant = Object.assign({}, req.tenant || {}, {
      slug: stateSlug,
      code: req.stateContext || (req.tenant && req.tenant.code) || '',
      name: stateName,
    });

    const scorecard = await scoreCounty(stateSlug, countySlug, req.stateContext);

    const html = renderForState(tenant, 'state/county-transparency.html', {
      REQUEST_HOST: req.headers.host,
      REQUEST_PATH: req.path,
      STATE_NAME: stateName,
      COUNTY_NAME: titleizeSlug(countySlug),
      COUNTY_SLUG: countySlug,
      SCORECARD_JSON: JSON.stringify(scorecard || {}),
      SCORECARD_HTML: renderScorecardHtml(scorecard),
    });
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

function renderScorecardHtml(scorecard) {
  if (!scorecard || !scorecard.counts || scorecard.counts.totalArticles === 0) {
    return `
      <div class="scorecard scorecard--empty">
        <p class="scorecard__empty">Not enough data yet to build a scorecard. Check back once blotters have been published.</p>
      </div>
    `;
  }

  const grade = scoreToGrade(scorecard.overall);
  const breakdown = scorecard.breakdown;
  const counts = scorecard.counts;

  const rows = Object.entries(breakdown).map(([key, value]) => `
    <tr class="scorecard__row">
      <th class="scorecard__metric-name">${metricLabel(key)}</th>
      <td class="scorecard__metric-value">
        <div class="score-bar" aria-label="${metricLabel(key)} ${value}%">
          <div class="score-bar__fill score-bar__fill--${scoreColor(value)}" style="width:${value}%"></div>
        </div>
        <span class="scorecard__metric-score">${value}</span>
      </td>
    </tr>
  `).join('');

  const meta = scorecard.level === 'state'
    ? `<li>${counts.countiesCovered || 0} of ${counts.totalCounties || 0} counties covered</li>`
    : '';

  return `
    <div class="scorecard">
      <div class="scorecard__overall">
        <span class="scorecard__grade scorecard__grade--${gradeClass(grade)}">${grade}</span>
        <span class="scorecard__score">${scorecard.overall}<small>/100</small></span>
      </div>
      <p class="scorecard__window">Scores are based on the last ${scorecard.windowDays} days of published data.</p>
      <table class="scorecard__table">
        <tbody>${rows}</tbody>
      </table>
      <ul class="scorecard__counts">
        ${meta}
        <li>${counts.totalArticles || 0} articles analyzed</li>
        <li>${counts.sourceTypes || 0} distinct source types</li>
        <li>${counts.daysSinceLastArticle === null ? 'No recent articles' : `${counts.daysSinceLastArticle} day${counts.daysSinceLastArticle === 1 ? '' : 's'} since last article`}</li>
      </ul>
    </div>
  `;
}

function metricLabel(key) {
  const labels = {
    coverage: 'County coverage',
    freshness: 'Content freshness',
    diversity: 'Source diversity',
    velocity: 'Publishing velocity',
    recency: 'Recency',
  };
  return labels[key] || key;
}

function scoreColor(value) {
  if (value >= 80) return 'good';
  if (value >= 50) return 'fair';
  return 'poor';
}

function scoreToGrade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function gradeClass(grade) {
  return { A: 'a', B: 'b', C: 'c', D: 'd', F: 'f' }[grade] || 'f';
}

/**
 * GET /blotter/:id — single blotter detail page.
 */
router.get('/blotter/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0 || String(id) !== req.params.id) {
      return res.status(404).type('html').send('Blotter not found.');
    }
    const result = await db.tenantQuery(req.stateContext, BLOTTER_DETAIL_SQL, [id]);
    if (!result.ok) {
      return res.status(503).type('html').send('Data plane unavailable');
    }
    if (!result.rows.length) {
      return res.status(404).type('html').send('Blotter not found.');
    }
    const b = result.rows[0];
    const stateSlug = req.subdomain || (req.tenant && req.tenant.slug) || '';
    const stateName = (req.tenant && req.tenant.name && String(req.tenant.name).trim())
      || titleizeSlug(stateSlug)
      || titleizeSlug(req.stateContext);
    const tenant = Object.assign({}, req.tenant || {}, {
      slug: stateSlug,
      code: req.stateContext || (req.tenant && req.tenant.code) || '',
      name: stateName,
    });
    const countyHtml = b.county
      ? `<a href="/county/${encodeURIComponent(b.county)}">${titleizeSlug(b.county)} County</a>`
      : '';
    res.type('html').send(renderForState(tenant, 'state/blotter.html', {
      REQUEST_HOST: req.headers.host,
      REQUEST_PATH: req.path,
      BLOTTER_ID: b.id,
      BLOTTER_TITLE: b.title,
      BLOTTER_SUMMARY: b.summary,
      BLOTTER_COUNTY: b.county || '',
      BLOTTER_COUNTY_HTML: countyHtml,
      BLOTTER_AGENCY: b.agency || '',
      BLOTTER_DATE: b.published_at instanceof Date
        ? b.published_at.toISOString().slice(0, 10)
        : b.published_at,
      BLOTTER_RAW_TEXT: b.raw_text || '',
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /healthz — surface check.
 */
router.get('/healthz', (req, res) =>
  res.json({ ok: true, surface: 'state-public', state: req.stateContext || null })
);

/**
 * GET /api/state/info — public state metadata.
 */
router.get('/api/state/info', (req, res) => {
  const t = req.tenant || {};
  res.json({
    code: req.stateContext,
    slug: t.slug || null,
    name: t.name || capitalize(req.stateContext),
    host: req.headers.host,
    status: 'active',
  });
});

/**
 * GET /api/blotters — JSON list (for any JS client hitting the tenant).
 */
router.get('/api/blotters', async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 25));
    const filterStateSlug = String(
      req.subdomain
      || (req.tenant && req.tenant.slug)
      || ''
    ).toLowerCase();
    const sql = BLOTTER_LIST_SQL_BASE
      + ' ORDER BY ga.created_at DESC, ga.id ASC LIMIT $1';
    const result = await db.tenantQuery(req.stateContext, sql, [limit, filterStateSlug]);
    if (!result.ok) {
      return res.status(503).json({ ok: false, error: result.error });
    }
    res.json({
      ok: true,
      state: req.stateContext,
      count: result.rowCount,
      blotters: result.rows.map((r) => ({
        id: r.id,
        title: r.title,
        summary: r.summary,
        agency: r.agency,
        published_at: r.published_at instanceof Date
          ? r.published_at.toISOString().slice(0, 10)
          : r.published_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
