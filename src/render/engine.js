'use strict';

const { render } = require('./template');
const { renderHomeFeed } = require('./views/home');

function cleanText(value) {
  return String(value || '').trim();
}

function renderTenantHome(context) {
  const articles = Array.isArray(context.articles) ? context.articles : [];
  const articleHtml = renderHomeFeed(articles);
  const stateName = cleanText(context.stateName);
  const stateSlug = cleanText(context.stateSlug);

  const html = render('tenant/home.html', {
    STATE_NAME: stateName,
    STATE_SLUG: stateSlug,
    ARTICLES_HTML: articleHtml,
    ARTICLE_COUNT: String(articles.length),
  });

  return html;
}

function renderTenantArticle(context) {
  const article = context.article || {};
  const rawRecord = context.rawRecord || {};
  const stateName = cleanText(context.stateName);
  const stateSlug = cleanText(context.stateSlug);
  const html = render('tenant/article.html', {
    STATE_NAME: stateName,
    STATE_SLUG: stateSlug,
    ARTICLE_HEADLINE: article.headline || '',
    ARTICLE_BODY_HTML: article.body_html || '',
    ARTICLE_SOURCE_TYPE: article.source_type || rawRecord.source_type || '',
    ARTICLE_CREATED_AT: article.created_at || '',
    ARTICLE_SOURCE_URL: rawRecord.source_url || article.source_url || '',
    ARTICLE_SOURCE_NAME: rawRecord.source_name || article.source_name || '',
    RAW_TEXT: rawRecord.raw_text || '',
    RAW_TEXT_ESCAPED: rawRecord.raw_text || '',
  });

  return html;
}

module.exports = {
  renderTenantHome,
  renderTenantArticle,
};
