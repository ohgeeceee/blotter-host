'use strict';

const express = require('express');
const db = require('../db/pg');
const { renderTenantHome, renderTenantArticle } = require('../render/engine');
const { ROOT_DOMAIN } = require('../middleware/subdomain');

const router = express.Router();

const ROOT_PAGES = new Set(['about', 'methodology', 'corrections', 'subscribe']);

function redirectToRoot(page) {
  return (_req, res) => {
    res.redirect(301, `https://${ROOT_DOMAIN}/${page}`);
  };
}

for (const page of ROOT_PAGES) {
  router.get(`/${page}`, redirectToRoot(page));
}

router.get('/archive', (_req, res) => {
  res.redirect(301, '/');
});

function titleizeSlug(value) {
  const slug = String(value || '').trim();
  if (!slug) return '';
  return slug
    .split('-')
    .map((part) => part ? part.charAt(0).toUpperCase() + part.slice(1) : part)
    .join(' ');
}

const LATEST_ARTICLES_SQL = `
  SELECT * FROM generated_articles
  WHERE state = $1
  ORDER BY created_at DESC
`;

const ARTICLE_DETAIL_SQL = `
  SELECT
    ga.id,
    ga.state,
    ga.source_type,
    ga.headline,
    ga.body,
    ga.body_html,
    ga.publication_status,
    ga.published_at,
    ga.created_at,
    rr.id AS raw_record_id,
    rr.source_url,
    rr.source_name,
    rr.raw_text,
    rr.raw_html,
    rr.raw_payload,
    rr.created_at AS raw_created_at
  FROM generated_articles ga
  JOIN raw_records rr ON rr.id = ga.raw_record_id
  WHERE ga.state = $1
    AND ga.id = $2
  LIMIT 1
`;

router.get('/', async (req, res, next) => {
  try {
    const state = String(req.state && (req.state.state || req.state.slug || '')).trim();
    if (!state) {
      return res.status(400).type('text').send('Missing tenant state context');
    }

    const result = await db.adminQuery(LATEST_ARTICLES_SQL, [state]);
    if (!result.ok) {
      return res.status(503).type('text').send('Data plane unavailable');
    }

    const stateName = req.state && req.state.name ? String(req.state.name).trim() : '';
    const displayName = stateName || titleizeSlug(state);

    const html = renderTenantHome({
      stateName: displayName,
      stateSlug: req.state && req.state.slug ? String(req.state.slug).trim() : '',
      articles: result.rows,
    });

    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return res.type('html').send(html);
  } catch (err) {
    return next(err);
  }
});

router.get('/article/:id', async (req, res, next) => {
  try {
    const state = String(req.state && (req.state.state || req.state.slug || '')).trim();
    const articleId = parseInt(req.params.id, 10);
    if (!state) {
      return res.status(400).type('text').send('Missing tenant state context');
    }
    if (!Number.isInteger(articleId) || articleId <= 0) {
      return res.status(400).type('text').send('Invalid article id');
    }

    const result = await db.adminQuery(ARTICLE_DETAIL_SQL, [state, articleId]);
    if (!result.ok) {
      return res.status(503).type('text').send('Data plane unavailable');
    }
    if (!result.rows.length) {
      return res.status(404).type('text').send('Article not found');
    }

    const row = result.rows[0];
    const stateName = req.state && req.state.name ? String(req.state.name).trim() : '';
    const displayName = stateName || titleizeSlug(state);
    const html = renderTenantArticle({
      stateName: displayName,
      stateSlug: req.state && req.state.slug ? String(req.state.slug).trim() : '',
      article: row,
      rawRecord: row,
    });

    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return res.type('html').send(html);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
