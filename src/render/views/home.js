'use strict';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return escapeHtml(value);
  }
  return new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function renderArticleCard(article) {
  const headline = escapeHtml(article.headline || 'Untitled article');
  const timestamp = formatTimestamp(article.published_at || article.created_at || article.timestamp);
  const sourceUrl = escapeHtml(article.source_url || article.sourceUrl || '#');
  const body = article.body_html || '';

  return [
    '<article class="news-card">',
    '  <header class="news-card__header">',
    `    <h2 class="news-card__headline">${headline}</h2>`,
    timestamp ? `    <time class="news-card__time" datetime="${escapeHtml(article.published_at || article.created_at || article.timestamp || '')}">${escapeHtml(timestamp)}</time>` : '',
    '  </header>',
    '  <div class="news-card__body">',
    `    ${body}`,
    '  </div>',
    '  <footer class="news-card__footer">',
    `    <a class="news-card__link" href="${sourceUrl}" rel="noopener noreferrer" target="_blank">Read more</a>`,
    '  </footer>',
    '</article>',
  ].filter(Boolean).join('\n');
}

function renderHomeFeed(articles) {
  const list = Array.isArray(articles) ? articles : [];
  if (!list.length) {
    return '<p class="empty-state">No recent articles yet.</p>';
  }

  return list.map(renderArticleCard).join('\n');
}

module.exports = {
  escapeHtml,
  formatTimestamp,
  renderArticleCard,
  renderHomeFeed,
};
