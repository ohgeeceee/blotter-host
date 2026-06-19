'use strict';

/**
 * Pure formatting helpers used by the control room.
 * Kept dependency-free so they can be reused by the data layer
 * and the view layer without circular imports.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`;
}

function formatNumber(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

function timeAgo(date, now = Date.now()) {
  if (!date) return 'never';
  const t = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (Number.isNaN(t)) return 'never';
  const delta = now - t;
  if (delta < 0) return 'just now';
  if (delta < 45 * SECOND) return 'just now';
  if (delta < 90 * SECOND) return 'a minute ago';
  if (delta < 45 * MINUTE) return `${Math.round(delta / MINUTE)} min ago`;
  if (delta < 90 * MINUTE) return 'an hour ago';
  if (delta < 22 * HOUR) return `${Math.round(delta / HOUR)} hours ago`;
  if (delta < 36 * HOUR) return 'a day ago';
  if (delta < 26 * DAY) return `${Math.round(delta / DAY)} days ago`;
  if (delta < 45 * DAY) return 'a month ago';
  if (delta < 11 * MONTH) return `${Math.round(delta / WEEK / 4.33)} months ago`;
  return `on ${new Date(t).toISOString().slice(0, 10)}`;
}

function toIsoOrNull(date) {
  if (!date) return null;
  const t = date instanceof Date ? date.getTime() : new Date(date).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

module.exports = { formatBytes, formatNumber, timeAgo, toIsoOrNull };
