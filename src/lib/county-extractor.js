'use strict';

/**
 * Extract a county name from public-record raw text.
 *
 * Strategy:
 * 1. Look for explicit "<Name> County" mentions (case-insensitive).
 * 2. If more than one county is mentioned, prefer the one that appears
 *    closest to the start of the text and/or most frequently.
 * 3. Slugify the result for URLs.
 *
 * This is intentionally lightweight for the MVP. A future registry-driven
 * version can validate against a canonical county list.
 */

const COUNTY_RE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+County\b/g;

function slugifyCounty(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\bcounty\b/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function titleizeCounty(slug) {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function extractCounty(text) {
  const s = String(text || '');
  const matches = new Map();
  let m;
  while ((m = COUNTY_RE.exec(s)) !== null) {
    const name = m[1].trim();
    const slug = slugifyCounty(name);
    if (!slug) continue;
    const existing = matches.get(slug);
    if (existing) {
      existing.count += 1;
      existing.firstIndex = Math.min(existing.firstIndex, m.index);
    } else {
      matches.set(slug, { name, slug, count: 1, firstIndex: m.index });
    }
  }

  if (!matches.size) return null;

  // Prefer earliest mention, then most frequent.
  const ranked = Array.from(matches.values()).sort((a, b) => {
    if (a.firstIndex !== b.firstIndex) return a.firstIndex - b.firstIndex;
    return b.count - a.count;
  });

  return ranked[0];
}

module.exports = {
  extractCounty,
  slugifyCounty,
  titleizeCounty,
};
