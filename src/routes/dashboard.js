'use strict';

const express = require('express');
const router = express.Router();

const { render, escapeHtml } = require('../render/template');
const { getNetworkStatus, OFFLINE_AFTER_MS } = require('../data/tenants');
const { formatBytes, formatNumber, timeAgo, toIsoOrNull } = require('../lib/format');

/**
 * Central control room — only served on the apex (blotter.host).
 * The caller in server.js must already guard req.isMainDomain.
 *
 * The route does all of the data gathering + pre-formatting, then
 * hands a flat context of strings to the template engine. The engine
 * has no iteration primitive, so the per-tenant table rows are
 * pre-rendered into a single HTML string before being interpolated
 * with triple-brace {{{ }}}.
 */

const OFFLINE_AFTER_HOURS = Math.round(OFFLINE_AFTER_MS / (60 * 60 * 1000));

function buildMetricCard(label, valueDisplay, valueTitle, hint) {
  return [
    '<div class="metric">',
    '  <dt class="metric__label">' + escapeHtml(label) + '</dt>',
    '  <dd class="metric__value" title="' + escapeHtml(valueTitle || valueDisplay) + '">',
    escapeHtml(valueDisplay),
    '  </dd>',
    hint ? '  <dd class="metric__hint">' + escapeHtml(hint) + '</dd>' : '',
    '</div>',
  ].join('\n');
}

function buildStatusPill(status) {
  const isActive = status === 'active';
  return [
    '<span class="status-pill status-pill--' + (isActive ? 'active' : 'offline') + '">',
    '  <span class="status-pill__dot" aria-hidden="true"></span>',
    '  <span class="status-pill__label">' + (isActive ? 'Active' : 'Offline') + '</span>',
    '</span>',
  ].join('');
}

function buildTenantRow(t) {
  const lastRunHuman = timeAgo(t.lastSuccessfulRun);
  const lastRunIso = toIsoOrNull(t.lastSuccessfulRun);
  const recordsDisplay = t.records == null ? '—' : formatNumber(t.records);
  const sizeDisplay = t.dbSizeBytes == null ? '—' : formatBytes(t.dbSizeBytes);
  const runningPill = t.scraperRunning
    ? '<span class="scraper-pill scraper-pill--running">Running</span>'
    : '<span class="scraper-pill scraper-pill--idle">Idle</span>';

  return [
    '<tr class="tenant-row tenant-row--' + t.status + '">',
    '  <th scope="row" class="tenant-row__name">',
    '    <a class="tenant-row__link" href="https://' + escapeHtml(t.host) + '/">',
    escapeHtml(t.displayName),
    '    </a>',
    '    <span class="tenant-row__host">' + escapeHtml(t.host) + '</span>',
    '  </th>',
    '  <td class="tenant-row__status">' + buildStatusPill(t.status) + '</td>',
    '  <td class="tenant-row__records">' + recordsDisplay + '</td>',
    '  <td class="tenant-row__size">' + sizeDisplay + '</td>',
    '  <td class="tenant-row__scraper">',
    '    <code class="tenant-row__scraper-name">' + escapeHtml(t.scraperName) + '</code>',
    '    ' + runningPill,
    '  </td>',
    '  <td class="tenant-row__last-run">',
    lastRunIso
      ? '<time class="tenant-row__time" datetime="' + lastRunIso + '" title="' + lastRunIso + '">'
        + escapeHtml(lastRunHuman) + '</time>'
      : '<span class="tenant-row__time tenant-row__time--missing">never</span>',
    '  </td>',
    '</tr>',
  ].join('\n');
}

function buildContext() {
  const status = getNetworkStatus();
  const n = status.network;

  const metrics = [
    buildMetricCard(
      'Records across the network',
      formatNumber(n.totalRecords),
      n.totalRecords.toLocaleString('en-US') + ' records',
      n.tenantCount + ' tenant' + (n.tenantCount === 1 ? '' : 's') + ' configured'
    ),
    buildMetricCard(
      'Total database size',
      formatBytes(n.totalDbSizeBytes),
      n.totalDbSizeBytes.toLocaleString('en-US') + ' bytes',
      'sum of all tenant blotter.db files'
    ),
    buildMetricCard(
      'Active scrapers',
      String(n.activeScrapers) + ' / ' + String(n.configuredScrapers),
      n.activeScrapers + ' currently running of ' + n.configuredScrapers + ' configured',
      'scrapers left running across the fleet'
    ),
  ].join('\n');

  const statusSummary =
    n.activeTenants + ' of ' + n.tenantCount + ' states active'
    + ' (offline threshold: >' + OFFLINE_AFTER_HOURS + 'h since last run)';

  const tenantRows = status.tenants.map(buildTenantRow).join('\n');

  // {{#if}} in partials is not evaluated by the engine (it runs only on the
  // top-level template, *before* partials are inlined), so the "synthetic
  // data" notice is pre-rendered here and passed in as a raw token.
  const isMocked = status.tenants.some((t) => t.mocked);
  const footerNoticeHtml = isMocked
    ? '<p class="page-footer__notice">'
      + 'Showing synthetic data — no tenant artifacts found on disk for one or more states.'
      + '</p>'
    : '';

  return {
    PAGE_TITLE: 'Control Room — blotter.host',
    GENERATED_AT_HUMAN: new Date(status.generatedAt).toUTCString(),
    GENERATED_AT_ISO: status.generatedAt,
    STATUS_SUMMARY: statusSummary,
    METRICS_HTML: metrics,
    TENANT_ROWS_HTML: tenantRows
      || '<tr><td colspan="6" class="tenant-row__empty">No tenants registered.</td></tr>',
    TENANT_COUNT: n.tenantCount,
    ACTIVE_TENANT_COUNT: n.activeTenants,
    FOOTER_NOTICE_HTML: footerNoticeHtml,
  };
}

router.get('/', (req, res) => {
  const ctx = buildContext();
  const html = render('dashboard/index.html', ctx);
  res.type('html').send(html);
});

router.get('/api/metrics', (_req, res) => {
  res.json(getNetworkStatus());
});

router.get('/healthz', (req, res) =>
  res.json({ ok: true, surface: 'dashboard' })
);

module.exports = router;
