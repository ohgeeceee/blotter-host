'use strict';

(function () {
  const XHR_HDR = { 'X-Requested-With': 'XMLHttpRequest' };

  const form = document.getElementById('news-source-form');
  const sourceIdInput = document.getElementById('source-id');
  const stateSelect = document.getElementById('source-state');
  const nameInput = document.getElementById('source-name');
  const urlInput = document.getElementById('source-url');
  const typeSelect = document.getElementById('source-type');
  const strategySelect = document.getElementById('source-strategy');
  const priorityInput = document.getElementById('source-priority');
  const enabledCheckbox = document.getElementById('source-enabled');
  const saveBtn = document.getElementById('source-save');
  const cancelBtn = document.getElementById('source-cancel');
  const messageEl = document.getElementById('source-form-message');
  const sourcesBody = document.getElementById('sources-body');
  const stateFilter = document.getElementById('list-state-filter');
  const refreshBtn = document.getElementById('sources-refresh');
  const runBtn = document.getElementById('sources-run');

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(s) {
    return String(s == null ? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function showMessage(text, isError) {
    messageEl.textContent = text;
    messageEl.className = 'form-message' + (isError ? ' form-message--error' : ' form-message--ok');
    if (!isError) {
      setTimeout(function () {
        if (messageEl.textContent === text) {
          messageEl.textContent = '';
          messageEl.className = 'form-message';
        }
      }, 4000);
    }
  }

  function resetForm() {
    sourceIdInput.value = '';
    stateSelect.value = '';
    nameInput.value = '';
    urlInput.value = '';
    typeSelect.value = 'rss';
    strategySelect.value = 'rssBulletin';
    priorityInput.value = '100';
    enabledCheckbox.checked = true;
    saveBtn.textContent = 'Save source';
    cancelBtn.hidden = true;
  }

  function syncStrategyFromType() {
    const type = typeSelect.value;
    if (type === 'rss') {
      strategySelect.value = 'rssBulletin';
    } else if (strategySelect.value === 'rssBulletin') {
      strategySelect.value = 'staticBulletin';
    }
  }

  function collectFormBody() {
    return {
      state_slug: stateSelect.value,
      source_name: nameInput.value.trim(),
      source_url: urlInput.value.trim(),
      source_type: typeSelect.value,
      strategy: strategySelect.value,
      priority: parseInt(priorityInput.value, 10) || 100,
      is_enabled: enabledCheckbox.checked,
    };
  }

  async function apiJson(path, init) {
    const res = await fetch(path, {
      method: init ? (init.method || 'GET') : 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' }, init ? init.headers : {}, XHR_HDR),
      credentials: 'same-origin',
      body: init && init.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    let body = {};
    try { body = JSON.parse(text); } catch (_e) {}
    if (!res.ok || !body.ok) throw new Error(body.error || ('HTTP ' + res.status));
    return body;
  }

  function renderSources(rows) {
    if (!rows || !rows.length) {
      sourcesBody.innerHTML = '<tr><td colspan="6" class="board-table__loading">No news sources configured yet.</td></tr>';
      return;
    }
    sourcesBody.innerHTML = rows.map(function (s) {
      const enabledClass = s.is_enabled ? 'source-row--enabled' : 'source-row--disabled';
      return '<tr class="source-row ' + enabledClass + '" data-id="' + s.id + '">' +
        '<td><strong class="source-row__name">' + escapeHtml(s.source_name) + '</strong></td>' +
        '<td><span class="source-row__state">' + escapeHtml(s.state_slug) + '</span></td>' +
        '<td><a href="' + escapeAttr(s.source_url) + '" target="_blank" rel="noopener">' + escapeHtml(s.source_url) + '</a></td>' +
        '<td><code>' + escapeHtml(s.source_type) + '</code> / <code>' + escapeHtml(s.strategy) + '</code></td>' +
        '<td>' + (s.is_enabled ? 'Enabled' : 'Disabled') + '</td>' +
        '<td class="actions-col">' +
          '<button type="button" class="btn btn--ghost btn--small" data-action="test" data-id="' + s.id + '">Test</button> ' +
          '<button type="button" class="btn btn--ghost btn--small" data-action="edit" data-id="' + s.id + '">Edit</button> ' +
          '<button type="button" class="btn btn--danger btn--small" data-action="delete" data-id="' + s.id + '">Delete</button>' +
        '</td>' +
      '</tr>';
    }).join('');
  }

  async function loadSources() {
    try {
      const state = stateFilter.value || '';
      const path = state ? '/admin/api/news-sources?state=' + encodeURIComponent(state) : '/admin/api/news-sources';
      const body = await apiJson(path);
      renderSources(body.sources);
    } catch (err) {
      sourcesBody.innerHTML = '<tr><td colspan="6" class="board-table__loading">Failed to load: ' + escapeHtml(err.message) + '</td></tr>';
    }
  }

  async function saveSource(ev) {
    ev.preventDefault();
    const payload = collectFormBody();
    const id = sourceIdInput.value ? parseInt(sourceIdInput.value, 10) : null;

    try {
      saveBtn.disabled = true;
      if (id) {
        await apiJson('/admin/api/news-sources/' + id, { method: 'PUT', body: payload });
        showMessage('Source updated.', false);
      } else {
        await apiJson('/admin/api/news-sources', { method: 'POST', body: payload });
        showMessage('Source created.', false);
      }
      resetForm();
      await loadSources();
    } catch (err) {
      showMessage(err.message, true);
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function testSource(id) {
    try {
      const body = await apiJson('/admin/api/news-sources/' + id + '/test', { method: 'POST' });
      const rssNote = body.looks_like_rss ? ' (looks like RSS)' : '';
      alert('Reachable: ' + body.reachable + ', status ' + body.status + rssNote);
    } catch (err) {
      alert('Test failed: ' + err.message);
    }
  }

  async function editSource(id) {
    try {
      const body = await apiJson('/admin/api/news-sources/' + id);
      const s = body.source;
      sourceIdInput.value = s.id;
      stateSelect.value = s.state_slug;
      nameInput.value = s.source_name;
      urlInput.value = s.source_url;
      typeSelect.value = s.source_type;
      strategySelect.value = s.strategy;
      priorityInput.value = s.priority;
      enabledCheckbox.checked = s.is_enabled;
      saveBtn.textContent = 'Update source';
      cancelBtn.hidden = false;
      form.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      showMessage(err.message, true);
    }
  }

  async function deleteSource(id) {
    if (!confirm('Delete this news source?')) return;
    try {
      await apiJson('/admin/api/news-sources/' + id, { method: 'DELETE' });
      await loadSources();
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  }

  async function runSources() {
    const state = stateFilter.value;
    if (!state) {
      alert('Select a state to run the scraper for.');
      return;
    }
    runBtn.disabled = true;
    try {
      const body = await apiJson('/admin/api/news-sources/run', {
        method: 'POST',
        body: { state_slug: state },
      });
      alert('Scraper run complete. ' + (body.sourcesRun || 0) + ' source(s) processed.');
    } catch (err) {
      alert('Run failed: ' + err.message);
    } finally {
      runBtn.disabled = false;
    }
  }

  form.addEventListener('submit', saveSource);
  cancelBtn.addEventListener('click', resetForm);
  typeSelect.addEventListener('change', syncStrategyFromType);
  refreshBtn.addEventListener('click', loadSources);
  runBtn.addEventListener('click', runSources);
  stateFilter.addEventListener('change', loadSources);

  sourcesBody.addEventListener('click', function (ev) {
    const btn = ev.target.closest('button[data-action]');
    if (!btn) return;
    const id = parseInt(btn.getAttribute('data-id'), 10);
    const action = btn.getAttribute('data-action');
    if (action === 'test') testSource(id);
    else if (action === 'edit') editSource(id);
    else if (action === 'delete') deleteSource(id);
  });

  loadSources();
})();
