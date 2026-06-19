'use strict';

(function () {
  const XHR_HDR = { 'X-Requested-With': 'XMLHttpRequest' };
  const $ = (sel, root) => (root || document).querySelector(sel);

  /* ----- DOM refs ----- */
  const mastheadTime = $('#masthead-time');
  const mastheadTenantCount = $('#masthead-tenant-count');
  const mastheadStateCount = $('#masthead-state-count');
  const mastheadPosture = $('#masthead-posture');
  const mastheadReadiness = $('#masthead-readiness');
  const stateDeskList = $('#state-desk-list');
  const tenantsBody = $('#tenants-body');
  const tenantsRefresh = $('#tenants-refresh');
  const settingsSave = $('#settings-save');
  const readinessList = $('#readiness-list');
  const logFeed = $('#log-feed');
  const logTenantFilter = $('#log-tenant-filter');
  const logSeverityFilter = $('#log-severity-filter');
  const logClear = $('#log-clear');
  const logConn = $('#log-conn');

  let tenants = [];
  let eventSource = null;
  let settingsPayload = null;

  /* ----- Helpers ----- */

  function fmtTime(iso) {
    if (!iso) return '\u2014';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '\u2014';
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  }

  function fmtRelative(iso) {
    if (!iso) return '\u2014';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '\u2014';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ----- Clock ----- */

  function updateClock() {
    if (mastheadTime) {
      mastheadTime.textContent = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') + 'Z';
    }
  }

  /* ----- Masthead ----- */

  function renderMasthead(body) {
    const settings = body.settings || {};
    const network = settings.network || {};
    const production = settings.production || {};
    const states = body.states || [];

    /* Tenant count — updated by renderTenants too */
    updateTenantCount();

    /* State counts */
    const live = states.filter(function (s) { return s.launchStatus === 'live'; }).length;
    const attention = states.filter(function (s) { return s.launchStatus === 'needs_attention'; }).length;
    if (mastheadStateCount) {
      mastheadStateCount.textContent = live + ' live' + (attention ? ' / ' + attention + ' attention' : '');
    }

    /* Posture summary */
    const parts = [];
    if (network.launchMode) parts.push(network.launchMode.charAt(0).toUpperCase() + network.launchMode.slice(1));
    if (production.tlsMode) parts.push(production.tlsMode.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }));
    if (production.databaseMode) parts.push(production.databaseMode.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }));
    if (production.scraperControllerMode) parts.push(production.scraperControllerMode.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }));
    if (mastheadPosture) mastheadPosture.textContent = parts.join(' \u00b7 ');

    /* Readiness */
    renderReadiness(body.readiness || []);
  }

  function updateTenantCount() {
    if (mastheadTenantCount) {
      const n = tenants.length;
      mastheadTenantCount.textContent = n + ' tenant' + (n !== 1 ? 's' : '');
    }
  }

  /* ----- State Desk ----- */

  function renderStateDesk(rows) {
    const list = (rows || []).filter(function (row) { return row.hasCommand; });
    if (!list.length) {
      stateDeskList.innerHTML = '<p class="state-desk__loading">No configured states yet.</p>';
      return;
    }
    stateDeskList.innerHTML = list.map(function (row) {
      var statusCls = row.launchStatus || 'configured';
      var statusLabel = statusCls.replace(/_/g, ' ');
      return ''
        + '<div class="state-row state-row--' + escapeHtml(statusCls) + '">'
        + '  <span class="state-row__dot"></span>'
        + '  <span class="state-row__code">' + escapeHtml(row.code || (row.slug || '').toUpperCase()) + '</span>'
        + '  <span class="state-row__name">' + escapeHtml(row.name) + '</span>'
        + '  <span class="state-row__meta">' + (row.publicEnabled ? 'public' : 'hidden') + ' \u00b7 ' + (row.hasCommand ? 'scraper set' : 'no scraper') + '</span>'
        + '  <span class="state-row__status">' + escapeHtml(statusLabel) + '</span>'
        + '</div>';
    }).join('');
  }

  /* ----- Tenants / Assignment Board ----- */

  function renderTenants() {
    if (!tenants.length) {
      tenantsBody.innerHTML = '<tr><td colspan="5" class="board-table__loading">No tenants registered.</td></tr>';
      return;
    }
    var html = tenants.map(function (t) {
      var cls = [
        'tenant-row',
        t.paused ? 'is-paused' : '',
        t.isRunning ? 'is-running' : '',
      ].filter(Boolean).join(' ');

      var statusPill = t.isRunning
        ? '<span class="status-pill status-pill--offline"><span class="status-pill__dot"></span>Running</span>'
        : (t.paused
            ? '<span class="status-pill status-pill--offline"><span class="status-pill__dot"></span>Paused</span>'
            : '<span class="status-pill status-pill--active"><span class="status-pill__dot"></span>Idle</span>');

      var pauseBtn = t.paused
        ? '<button type="button" class="btn btn--primary" data-action="resume" data-slug="' + escapeHtml(t.slug) + '">Resume</button>'
        : '<button type="button" class="btn btn--danger" data-action="pause" data-slug="' + escapeHtml(t.slug) + '">Pause</button>';

      var runBtn = '<button type="button" class="btn" data-action="run" data-slug="' + escapeHtml(t.slug) + '"'
        + ((!t.hasCommand || t.paused) ? ' disabled' : '') + '>Run now</button>';

      var last = t.lastHeartbeat
        ? '<time datetime="' + escapeHtml(t.lastHeartbeat) + '" title="' + escapeHtml(fmtTime(t.lastHeartbeat)) + '">' + escapeHtml(fmtRelative(t.lastHeartbeat)) + '</time>'
        : '<span class="tenant-cell__last--missing">never</span>';

      var msg = t.lastMessage
        ? '<span class="tenant-cell__msg" title="' + escapeHtml(t.lastMessage) + '">' + escapeHtml(t.lastMessage) + '</span>'
        : '';

      return ''
        + '<tr class="' + cls + '">'
        + '  <th scope="row">'
        + '    <span class="tenant-cell__name">' + escapeHtml(t.name) + '</span>'
        + '    <span class="tenant-cell__host">' + escapeHtml(t.host) + '</span>'
        + '  </th>'
        + '  <td><code class="tenant-cell__scraper">' + (t.hasCommand ? 'configured' : 'none') + '</code></td>'
        + '  <td>' + statusPill + '</td>'
        + '  <td>' + last + msg + '</td>'
        + '  <td class="actions-col"><div class="action-row">' + runBtn + pauseBtn + '</div></td>'
        + '</tr>';
    }).join('');

    tenantsBody.innerHTML = html;
    populateTenantFilter();
    updateTenantCount();
  }

  function populateTenantFilter() {
    var current = logTenantFilter.value;
    var opts = ['<option value="">All</option>'].concat(
      tenants.map(function (t) { return '<option value="' + escapeHtml(t.slug) + '">' + escapeHtml(t.name) + '</option>'; })
    );
    logTenantFilter.innerHTML = opts.join('');
    if (tenants.some(function (t) { return t.slug === current; })) logTenantFilter.value = current;
  }

  async function loadTenants() {
    try {
      var [tenantsRes, metricsRes] = await Promise.all([
        fetch('/admin/api/tenants', { credentials: 'same-origin' }),
        fetch('/admin/api/metrics', { credentials: 'same-origin' }),
      ]);
      if (!tenantsRes.ok) throw new Error('HTTP ' + tenantsRes.status);
      if (!metricsRes.ok) throw new Error('HTTP ' + metricsRes.status);
      var body = await tenantsRes.json();
      var metrics = await metricsRes.json();
      var configured = new Set((metrics.tenants || []).map(function (t) { return t.slug; }));
      tenants = (body.tenants || []).filter(function (t) { return configured.has(t.slug); });
      renderTenants();
    } catch (err) {
      tenantsBody.innerHTML = '<tr><td colspan="5" class="board-table__loading">Failed to load: ' + escapeHtml(err.message) + '</td></tr>';
    }
  }

  /* ----- Settings ----- */

  function setField(id, value) {
    var el = $('#' + id);
    if (!el) return;
    if (el.type === 'checkbox') {
      el.checked = !!value;
    } else {
      el.value = value == null ? '' : String(value);
    }
  }

  function getField(id) {
    var el = $('#' + id);
    if (!el) return '';
    if (el.type === 'checkbox') return el.checked;
    return el.value;
  }

  function renderReadiness(rows) {
    readinessList.innerHTML = (rows || []).map(function (row) {
      var ok = row.status === 'ok';
      return ''
        + '<li class="readiness-item readiness-item--' + (ok ? 'ok' : 'warn') + '">'
        + '  <span class="readiness-item__status">' + (ok ? 'OK' : 'Needs attention') + '</span>'
        + '  <span class="readiness-item__label">' + escapeHtml(row.label) + '</span>'
        + '  <span class="readiness-item__detail">' + escapeHtml(row.detail || '') + '</span>'
        + '</li>';
    }).join('');

    /* Update masthead readiness count */
    if (mastheadReadiness) {
      var ready = (rows || []).filter(function (r) { return r.status === 'ok'; }).length;
      var needs = (rows || []).filter(function (r) { return r.status !== 'ok'; }).length;
      var text = ready + ' ready' + (needs ? ' / ' + needs + ' needs attention' : '');
      mastheadReadiness.textContent = text;
      mastheadReadiness.className = 'masthead__readiness' + (needs ? ' masthead__readiness--warn' : ' masthead__readiness--ok');
    }
  }

  function renderSettings(body) {
    settingsPayload = body.settings || {};
    var network = settingsPayload.network || {};
    var production = settingsPayload.production || {};
    var fleet = settingsPayload.fleet || {};
    setField('setting-platform-name', network.platformName || '');
    setField('setting-root-domain', network.rootDomain || '');
    setField('setting-admin-host', network.adminHost || '');
    setField('setting-support-email', network.supportEmail || '');
    setField('setting-launch-mode', network.launchMode || 'staging');
    setField('setting-tls-mode', production.tlsMode || 'self_signed');
    setField('setting-database-mode', production.databaseMode || 'local_or_unset');
    setField('setting-controller-mode', production.scraperControllerMode || 'manual');
    setField('setting-disclaimer', network.publicDisclaimer || '');
    setField('setting-scraper-schedule', fleet.defaultScraperSchedule || '');
    setField('setting-max-concurrent', fleet.maxConcurrentScrapers);
    setField('setting-scraper-timeout', fleet.scraperTimeoutMinutes);
    setField('setting-auto-publish', fleet.autoPublishDrafts);
    setField('setting-max-articles', fleet.maxArticlesPerRun);
    setField('setting-alert-webhook', fleet.alertWebhookUrl || '');
    setField('setting-alert-email', fleet.alertEmail || '');
    renderReadiness(body.readiness || []);
    renderStateDesk(body.states || []);

    /* Masthead counts that depend on settings */
    renderMasthead(body);
  }

  async function loadSettings() {
    try {
      var res = await fetch('/admin/api/settings', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      renderSettings(await res.json());
    } catch (err) {
      readinessList.innerHTML = '<li class="readiness-item readiness-item--warn"><span class="readiness-item__label">Settings failed to load</span><span class="readiness-item__detail">' + escapeHtml(err.message) + '</span></li>';
    }
  }

  async function saveSettings() {
    var body = {
      network: {
        platformName: getField('setting-platform-name'),
        rootDomain: getField('setting-root-domain'),
        adminHost: getField('setting-admin-host'),
        supportEmail: getField('setting-support-email'),
        launchMode: getField('setting-launch-mode'),
        publicDisclaimer: getField('setting-disclaimer'),
      },
      production: {
        tlsMode: getField('setting-tls-mode'),
        databaseMode: getField('setting-database-mode'),
        scraperControllerMode: getField('setting-controller-mode'),
      },
      fleet: {
        defaultScraperSchedule: getField('setting-scraper-schedule'),
        maxConcurrentScrapers: getField('setting-max-concurrent'),
        scraperTimeoutMinutes: getField('setting-scraper-timeout'),
        autoPublishDrafts: getField('setting-auto-publish'),
        maxArticlesPerRun: getField('setting-max-articles'),
        alertWebhookUrl: getField('setting-alert-webhook'),
        alertEmail: getField('setting-alert-email'),
      },
      states: settingsPayload && settingsPayload.states ? settingsPayload.states : {},
    };

    settingsSave.disabled = true;
    try {
      var res = await fetch('/admin/api/settings', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, XHR_HDR),
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      var payload = await res.json().catch(function () { return {}; });
      if (!res.ok || !payload.ok) throw new Error(payload.error || res.statusText);
      renderSettings(payload);
    } catch (err) {
      alert('Settings save failed: ' + err.message);
    } finally {
      settingsSave.disabled = false;
    }
  }

  /* ----- Scraper actions ----- */

  async function runScraper(slug) {
    var btn = tenantsBody.querySelector('[data-action="run"][data-slug="' + slug + '"]');
    if (btn) btn.disabled = true;
    try {
      var res = await fetch('/admin/api/tenants/' + encodeURIComponent(slug) + '/scraper/run', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, XHR_HDR),
        credentials: 'same-origin',
        body: '{}',
      });
      var body = await res.json().catch(function () { return {}; });
      if (!res.ok || !body.ok) {
        alert('Run failed: ' + (body.error || res.statusText));
      }
    } catch (err) {
      alert('Run error: ' + err.message);
    } finally {
      if (btn) btn.disabled = false;
      setTimeout(loadTenants, 800);
    }
  }

  async function setPaused(slug, paused) {
    try {
      var res = await fetch('/admin/api/tenants/' + encodeURIComponent(slug) + '/scraper/pause', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, XHR_HDR),
        credentials: 'same-origin',
        body: JSON.stringify({ paused: !!paused }),
      });
      if (!res.ok) {
        var body = await res.json().catch(function () { return {}; });
        alert('Pause failed: ' + (body.error || res.statusText));
      }
    } catch (err) {
      alert('Pause error: ' + err.message);
    } finally {
      loadTenants();
    }
  }

  /* ----- Event delegation for tenant actions ----- */

  tenantsBody.addEventListener('click', function (ev) {
    var btn = ev.target.closest('button[data-action]');
    if (!btn) return;
    var slug = btn.getAttribute('data-slug');
    var action = btn.getAttribute('data-action');
    if (action === 'run') runScraper(slug);
    else if (action === 'pause') setPaused(slug, true);
    else if (action === 'resume') setPaused(slug, false);
  });

  tenantsRefresh.addEventListener('click', loadTenants);
  if (settingsSave) settingsSave.addEventListener('click', saveSettings);

  /* ----- Log stream ----- */

  function severityRank(sev) {
    return ({ debug: 0, info: 1, warn: 2, error: 3 })[sev] != null
      ? ({ debug: 0, info: 1, warn: 2, error: 3 })[sev]
      : 1;
  }

  function applyFilters() {
    var t = logTenantFilter.value;
    var s = logSeverityFilter.value;
    var minRank = s ? severityRank(s) : 0;
    for (var i = 0; i < logFeed.children.length; i++) {
      var li = logFeed.children[i];
      var entryTenant = li.getAttribute('data-tenant') || '';
      var entrySev = li.getAttribute('data-severity') || 'info';
      var tenantOk = !t || entryTenant === t;
      var sevOk = severityRank(entrySev) >= minRank;
      li.classList.toggle('wire-entry--hidden', !(tenantOk && sevOk));
    }
  }

  function appendLog(row) {
    var li = document.createElement('li');
    li.className = 'wire-entry';
    li.setAttribute('data-id', String(row.id));
    li.setAttribute('data-tenant', row.tenant_slug || '');
    li.setAttribute('data-severity', row.severity || 'info');
    li.innerHTML =
      '<span class="wire-entry__ts">' + escapeHtml(fmtTime(row.ts)) + '</span>' +
      '<span class="wire-entry__sev wire-entry__sev--' + escapeHtml(row.severity || 'info') + '">' + escapeHtml(row.severity || 'info') + '</span>' +
      '<span class="wire-entry__tenant">' + escapeHtml(row.tenant_slug || '\u2014') + '</span>' +
      '<span class="wire-entry__msg">' + escapeHtml(row.message || '') + '</span>';

    logFeed.appendChild(li);
    while (logFeed.children.length > 500) logFeed.removeChild(logFeed.firstChild);
    if (logFeed.scrollHeight - logFeed.scrollTop - logFeed.clientHeight < 200) {
      logFeed.scrollTop = logFeed.scrollHeight;
    }
    applyFilters();
  }

  function setConn(state) {
    logConn.setAttribute('data-state', state);
    logConn.textContent = state;
  }

  function buildEventSource() {
    if (eventSource) {
      try { eventSource.close(); } catch (_e) { /* ignore */ }
      eventSource = null;
    }
    setConn('connecting');
    var es = new EventSource('/admin/api/logs/stream', { withCredentials: true });
    es.addEventListener('hello', function () { setConn('connected'); });
    es.addEventListener('log', function (ev) {
      try { appendLog(JSON.parse(ev.data)); } catch (_e) { /* ignore malformed */ }
    });
    es.addEventListener('error', function () { setConn('disconnected'); });
    es.onerror = function () { setConn('disconnected'); };
    eventSource = es;
  }

  logTenantFilter.addEventListener('change', applyFilters);
  logSeverityFilter.addEventListener('change', applyFilters);
  logClear.addEventListener('click', function () { logFeed.innerHTML = ''; });

  /* ----- Init ----- */

  updateClock();
  setInterval(updateClock, 1000);
  loadTenants();
  loadSettings();
  buildEventSource();
  setInterval(loadTenants, 15000);
})();
