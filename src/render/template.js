'use strict';

/**
 * Minimal vanilla-HTML template engine.
 *
 *   - {{TOKEN}}           HTML-escaped value from ctx
 *   - {{{TOKEN}}}         raw, unescaped (use only for values you built yourself)
 *   - {{> partials/foo}}  inlines another template file; recurses
 *   - {{#if TOKEN}}…{{/if}}  conditional block; '' / 0 / null / undefined / false are falsy
 *
 * No deps. No caching layer beyond an mtime-aware in-memory map of template
 * strings, so editing a file in dev is visible on the next request.
 *
 * Designed as a pure function — not Express middleware. Callers do:
 *
 *     const html = render('state/index.html', ctx);
 *     res.type('html').send(html);
 */

const fs = require('fs');
const path = require('path');

const VIEWS_ROOT = path.resolve(__dirname, '..', '..', 'views');

// path → { mtimeMs, source }
const cache = new Map();

function readTemplate(relPath) {
  // Allow partial references without the .html extension — the convention
  // {{> tenant/header}} should resolve to tenant/header.html.
  const candidates = [relPath];
  if (!path.extname(relPath)) candidates.push(relPath + '.html');

  let abs = null;
  for (const candidate of candidates) {
    const resolved = path.resolve(VIEWS_ROOT, candidate);
    if (!resolved.startsWith(VIEWS_ROOT + path.sep) && resolved !== VIEWS_ROOT) {
      throw new Error(`Template path escapes views root: ${candidate}`);
    }
    if (fs.existsSync(resolved)) { abs = resolved; break; }
  }
  if (!abs) {
    throw new Error(`Template not found: ${relPath} (tried ${candidates.join(', ')})`);
  }

  const stat = fs.statSync(abs);
  const hit = cache.get(abs);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.source;
  const source = fs.readFileSync(abs, 'utf8');
  cache.set(abs, { mtimeMs: stat.mtimeMs, source });
  return source;
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isFalsy(value) {
  return value === null || value === undefined || value === '' || value === 0 || value === false;
}

function render(relPath, ctx = {}) {
  const source = readTemplate(relPath);
  let out = source;

  // Expand {{#if K}}…{{/if}} first. We don't support nesting.
  out = out.replace(
    /\{\{#if\s+([A-Za-z0-9_.\-]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_m, key, body) => (isFalsy(ctx[key]) ? '' : body)
  );

  // Resolve partials. Loop because a partial can include another partial.
  let prev;
  do {
    prev = out;
    out = out.replace(/\{\{>\s*([A-Za-z0-9_.\-/.]+)\s*\}\}/g, (_m, partialPath) => {
      try {
        return readTemplate(partialPath);
      } catch (err) {
        throw new Error(`Partial not found: ${partialPath} (${err.message})`);
      }
    });
  } while (out !== prev);

  // Triple-brace = raw. Run first so the double-brace regex below doesn't
  // also match the inner pair of {{{x}}}.
  out = out.replace(/\{\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}\}/g, (_m, key) =>
    ctx[key] === undefined || ctx[key] === null ? '' : String(ctx[key])
  );
  // Double-brace = escaped.
  out = out.replace(/\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}/g, (_m, key) =>
    escapeHtml(ctx[key])
  );

  return out;
}

function _resetCache() {
  cache.clear();
}

module.exports = { render, escapeHtml, _resetCache };
