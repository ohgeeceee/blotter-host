'use strict';

/*
 * Idaho jail roster scraper for blotter.host.
 *
 * Minimal runtime: Node 20+ only. No DOM libraries, no build step.
 *
 * Default target is Ada County's official public inmate report. Additional
 * Idaho sources can be passed through --source-url/--county or added to
 * IDAHO_SOURCES for mission-control dispatch.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_USER_AGENT = 'blotter.host-idaho-ingest/1.0 (+https://blotter.host)';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RATE_LIMIT_MS = 1_500;

const IDAHO_SOURCES = Object.freeze({
  ada: {
    source_key: 'ada',
    state_code: 'ID',
    county: 'Ada',
    facility: 'Ada County Jail',
    source_url: 'https://apps.adacounty.id.gov/sheriff/reports/inmates.aspx',
    parser: 'auto',
  },
  canyon: {
    source_key: 'canyon',
    state_code: 'ID',
    county: 'Canyon',
    facility: 'Canyon County Jail',
    source_url: 'https://jailroster.canyoncounty.id.gov/',
    parser: 'auto',
  },
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(value) {
  return decodeEntities(String(value == null ? '' : value))
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)));
}

function stripTags(html) {
  return cleanText(String(html || '').replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
}

function titleName(raw) {
  const value = cleanText(raw);
  if (!value) return '';
  const comma = value.match(/^([^,]+),\s*(.+)$/);
  const ordered = comma ? `${comma[2]} ${comma[1]}` : value;
  return ordered
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.split('-').map(capitalizeWord).join('-'))
    .join(' ');
}

function capitalizeWord(word) {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function parseAge(value) {
  const m = cleanText(value).match(/\b(\d{1,3})\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n > 0 && n < 120 ? n : null;
}

function parseMoney(value) {
  const text = cleanText(value);
  if (!text || /no\s+bond|none|n\/a/i.test(text)) return null;
  const m = text.match(/\$?\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/);
  if (!m) return null;
  return Number(m[1].replace(/,/g, ''));
}

function parseBondType(value) {
  const text = cleanText(value);
  if (!text) return '';
  const withoutMoney = text.replace(/\$?\s*[0-9][0-9,]*(?:\.[0-9]{2})?/g, '').replace(/[-:]/g, ' ').trim();
  if (withoutMoney) return withoutMoney;
  if (/surety/i.test(text)) return 'Surety';
  if (/cash/i.test(text)) return 'Cash';
  if (/bond/i.test(text)) return 'Bond';
  return '';
}

function splitCharges(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') return item.description || item.offense || item.charge || item.name || '';
        return '';
      })
      .map(cleanText)
      .filter(Boolean);
  }

  return cleanText(value)
    .split(/\s*(?:;|\||\n|<br\s*\/?>)\s*/i)
    .map((s) => s.replace(/^\d+\.\s*/, ''))
    .map(cleanText)
    .filter(Boolean);
}

function parseDateTime(dateValue, timeValue) {
  const dateText = cleanText(dateValue);
  const timeText = cleanText(timeValue);
  const combined = cleanText([dateText, timeText].filter(Boolean).join(' '));
  if (!combined) return { booking_date: null, booking_time: null };

  const iso = combined.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?/);
  if (iso) {
    return {
      booking_date: `${iso[1]}-${iso[2]}-${iso[3]}`,
      booking_time: iso[4] ? `${iso[4]}:${iso[5]}` : null,
    };
  }

  const us = combined.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?)?/i);
  if (!us) return { booking_date: null, booking_time: null };

  const year = us[3].length === 2 ? `20${us[3]}` : us[3];
  const month = us[1].padStart(2, '0');
  const day = us[2].padStart(2, '0');
  let hour = us[4] ? parseInt(us[4], 10) : null;
  const minute = us[5] || null;
  const meridiem = (us[6] || '').toUpperCase();
  if (hour != null && meridiem === 'PM' && hour < 12) hour += 12;
  if (hour != null && meridiem === 'AM' && hour === 12) hour = 0;

  return {
    booking_date: `${year}-${month}-${day}`,
    booking_time: hour == null ? null : `${String(hour).padStart(2, '0')}:${minute}`,
  };
}

function absoluteUrl(candidate, sourceUrl) {
  const value = cleanText(candidate);
  if (!value) return '';
  try {
    return new URL(value, sourceUrl).toString();
  } catch (_err) {
    return '';
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function bondBucket(amount) {
  if (!Number.isFinite(amount) || amount <= 0) return 'unknown';
  if (amount < 2500) return 'low';
  if (amount < 10000) return 'medium';
  if (amount < 50000) return 'high';
  return 'premium';
}

function buildBailAdHook(record) {
  const amount = Number(record.bail_amount);
  const eligible = Number.isFinite(amount) && amount > 0 && !/no\s+bond/i.test(record.bond_type || '');
  const bucket = bondBucket(amount);
  const tiers = bucket === 'premium'
    ? ['premium', 'exclusive']
    : bucket === 'high'
      ? ['standard', 'premium', 'exclusive']
      : ['standard', 'premium', 'exclusive'];

  return {
    slot: 'idaho_bail_bonds_feed',
    state_code: record.state_code || 'ID',
    county: record.county || '',
    bond_bucket: bucket,
    bond_type: record.bond_type || '',
    eligible,
    ad_query: {
      state_code: record.state_code || 'ID',
      county: record.county || '',
      min_bond_amount: Number.isFinite(amount) ? amount : 0,
      package_tiers: tiers,
    },
  };
}

function normalizeBooking(input, context) {
  const dt = parseDateTime(input.booking_date || input.bookingDate || input.booked_at || input.booking_at, input.booking_time || input.bookingTime);
  const bail = parseMoney(input.bail_amount || input.bailAmount || input.bond || input.bondAmount || input.bail || '');
  const bondType = cleanText(input.bond_type || input.bondType || parseBondType(input.bond || input.bondAmount || input.bail || ''));
  const sourceUrl = context.sourceUrl || context.source_url || input.source_url || '';
  const mugshot = absoluteUrl(input.mugshot_url || input.mugshotUrl || input.photo || input.image || '', sourceUrl);

  const record = {
    schema_version: 'idaho-jail-booking-v1',
    state_code: context.state_code || 'ID',
    county: context.county || '',
    facility: context.facility || '',
    source_key: context.source_key || '',
    source_url: sourceUrl,
    source_record_id: cleanText(input.source_record_id || input.id || input.booking_number || input.bookingNumber || ''),
    arrestee_name: titleName(input.arrestee_name || input.name || input.person_name || input.inmateName || ''),
    age: parseAge(input.age),
    booking_date: dt.booking_date,
    booking_time: dt.booking_time,
    charges_list: splitCharges(input.charges_list || input.charges || input.charge || input.offenses || ''),
    bail_amount: bail,
    bond_type: bondType,
    mugshot_url: mugshot,
    arresting_agency: cleanText(input.arresting_agency || input.arrestingAgency || input.agency || input.arrestAgency || ''),
    raw_payload_hash: context.rawPayloadHash || '',
    collected_at: context.collectedAt || new Date().toISOString(),
  };

  record.record_hash = sha256(JSON.stringify({
    state_code: record.state_code,
    county: record.county,
    arrestee_name: record.arrestee_name,
    booking_date: record.booking_date,
    booking_time: record.booking_time,
    charges_list: record.charges_list,
    source_record_id: record.source_record_id,
  }));
  record.monetization = { bail_ad_hook: buildBailAdHook(record) };
  return record;
}

function tryJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

function findArrayPayload(obj) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object') return [];
  for (const key of ['inmates', 'bookings', 'records', 'data', 'rows', 'results']) {
    if (Array.isArray(obj[key])) return obj[key];
  }
  return [];
}

function mapJsonPayload(raw, context) {
  const parsed = typeof raw === 'string' ? tryJson(raw) : raw;
  const rows = findArrayPayload(parsed);
  return rows.map((row) => normalizeBooking(row, context)).filter((row) => row.arrestee_name);
}

function extractHiddenFields(html) {
  const fields = {};
  const inputRe = /<input\b[^>]*>/gi;
  let m;
  while ((m = inputRe.exec(String(html || '')))) {
    const tag = m[0];
    const type = attr(tag, 'type').toLowerCase();
    if (type && type !== 'hidden' && type !== 'text') continue;
    const name = attr(tag, 'name');
    if (!name) continue;
    fields[name] = attr(tag, 'value');
  }
  return fields;
}

function attr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i');
  const m = String(tag || '').match(re);
  return m ? decodeEntities(m[2]) : '';
}

function extractAdaArrestBlocks(html) {
  const blocks = [];
  const re = /<div\s+id=(["'])(\d+)\1\s+class=(["'])arrest\3[\s\S]*?(?=<div\s+id=(["'])\d+\4\s+class=(["'])arrest\5|<div\s+class=(["'])wrap\6|<\/form>|$)/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    blocks.push({ id: m[2], html: m[0] });
  }
  return blocks;
}

function parseAdaChargeRows(blockHtml) {
  const charges = [];
  const bailAmounts = [];
  let bondType = '';
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(blockHtml))) {
    const cells = [];
    const cellRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      cells.push(stripTags(cellMatch[1]));
    }
    if (cells.length < 4) continue;
    const charge = cleanText(cells[1]);
    const bailText = cleanText(cells[3]);
    if (charge && !/^charge$/i.test(charge)) charges.push(charge);
    const amount = parseMoney(bailText);
    if (Number.isFinite(amount)) bailAmounts.push(amount);
    if (!bondType && bailText) bondType = parseBondType(bailText) || bailText;
  }
  return {
    charges,
    bail_amount: bailAmounts.length ? Math.max(...bailAmounts) : null,
    bond_type: bondType,
  };
}

function mapAdaArrestBlocks(html, context) {
  const blocks = extractAdaArrestBlocks(html);
  return blocks.map((block) => {
    const name = (block.html.match(/<div class=(["'])myNameTitle\1>[\s\S]*?<strong>([\s\S]*?)<\/strong>/i) || [])[2] || '';
    const jid = (block.html.match(/JID Number:\s*<strong>(.*?)<\/strong>/i) || [])[1] || block.id;
    const age = (block.html.match(/Age:\s*([0-9]{1,3})/i) || [])[1] || '';
    const agency = (block.html.match(/Arresting Agency:\s*([^<]+?)(?:<|$)/i) || [])[1] || '';
    const imgTag = (block.html.match(/<img\b[^>]*class=(["'])img-rounded mugshot\1[^>]*>/i) || block.html.match(/<img\b[^>]*class=(["'])mugshot\1[^>]*>/i) || [])[0] || '';
    const imgSrc = attr(imgTag, 'src');
    const chargeInfo = parseAdaChargeRows(block.html);
    return normalizeBooking({
      source_record_id: jid,
      name,
      age,
      charges: chargeInfo.charges,
      bail_amount: chargeInfo.bail_amount,
      bond_type: chargeInfo.bond_type,
      mugshot_url: imgSrc && !imgSrc.startsWith('data:') ? imgSrc : '',
      agency,
    }, context);
  }).filter((row) => row.arrestee_name && row.charges_list.length);
}

function extractTables(html) {
  const tables = [];
  const tableRe = /<table\b[\s\S]*?<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tableRe.exec(html))) {
    const table = tableMatch[0];
    const rows = [];
    const trRe = /<tr\b[\s\S]*?<\/tr>/gi;
    let trMatch;
    while ((trMatch = trRe.exec(table))) {
      const cells = [];
      const cellRe = /<(t[dh])\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cellMatch;
      while ((cellMatch = cellRe.exec(trMatch[0]))) {
        const fragment = cellMatch[2];
        const img = fragment.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
        cells.push({ text: stripTags(fragment), img: img ? decodeEntities(img[1]) : '' });
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

function headerKey(label) {
  const text = cleanText(label).toLowerCase();
  if (/name|inmate/.test(text)) return 'name';
  if (/agency|arresting/.test(text)) return 'agency';
  if (/age/.test(text)) return 'age';
  if (/booking\s*date|booked\s*date|date\s*booked/.test(text)) return 'booking_date';
  if (/booking\s*time|booked\s*time|time\s*booked/.test(text)) return 'booking_time';
  if (/booked|booking/.test(text)) return 'booking_date';
  if (/charge|offense|offence/.test(text)) return 'charges';
  if (/bond|bail/.test(text)) return 'bond';
  if (/photo|mug|image/.test(text)) return 'photo';
  if (/booking\s*#|booking\s*number|id/.test(text)) return 'booking_number';
  return text.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function mapHtmlTables(html, context) {
  const records = [];
  for (const table of extractTables(html)) {
    if (table.length < 2) continue;
    const headers = table[0].map((cell) => headerKey(cell.text));
    if (!headers.includes('name')) continue;

    for (const row of table.slice(1)) {
      const obj = {};
      for (let i = 0; i < headers.length; i++) {
        const key = headers[i];
        const cell = row[i] || { text: '', img: '' };
        obj[key] = cell.text;
        if (cell.img) obj.photo = cell.img;
      }
      records.push(normalizeBooking({
        name: obj.name,
        age: obj.age,
        booking_date: obj.booking_date,
        booking_time: obj.booking_time,
        charges: obj.charges,
        bond: obj.bond,
        agency: obj.agency,
        mugshot_url: obj.photo,
        booking_number: obj.booking_number,
      }, context));
    }
  }
  return records.filter((row) => row.arrestee_name);
}

function extractEmbeddedJson(html) {
  const candidates = [];
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html))) {
    const body = m[1].trim();
    if (!body) continue;
    const direct = tryJson(body);
    if (direct) candidates.push(direct);
    const arrays = body.match(/\[[\s\S]{20,}?\]/g) || [];
    for (const arr of arrays) {
      const parsed = tryJson(arr);
      if (parsed) candidates.push(parsed);
    }
  }
  return candidates;
}

function mapTextCards(html, context) {
  const text = stripTags(html.replace(/<\/(?:tr|div|li|p|br|section|article)>/gi, '\n'));
  const chunks = text.split(/\n{2,}|(?=\b[A-Z][A-Z' -]+,\s*[A-Z])/).map(cleanText).filter(Boolean);
  const records = [];
  for (const chunk of chunks) {
    if (!/(booking|charge|bond|bail)/i.test(chunk)) continue;
    const nameMatch = chunk.match(/(?:name|inmate)\s*:?\s*([A-Z][A-Z' ,.-]{3,})/i) || chunk.match(/^([A-Z][A-Z' .-]+,\s*[A-Z][A-Z' .-]+)/);
    const name = nameMatch ? nameMatch[1] : '';
    if (!name) continue;
    records.push(normalizeBooking({
      name,
      age: (chunk.match(/\bage\s*:?\s*(\d{1,3})/i) || [])[1],
      booking_date: (chunk.match(/booking(?:\s+date)?\s*:?\s*([0-9/T: .-]+(?:AM|PM)?)/i) || [])[1],
      charges: (chunk.match(/charges?\s*:?\s*(.*?)(?:\s+bond|\s+bail|$)/i) || [])[1],
      bond: (chunk.match(/(?:bond|bail)\s*:?\s*([^;]+?)(?:\s+agency|$)/i) || [])[1],
      agency: (chunk.match(/agency\s*:?\s*(.+)$/i) || [])[1],
    }, context));
  }
  return records.filter((row) => row.arrestee_name);
}

function mapIdahoRosterPayload(rawPayload, opts = {}) {
  const raw = String(rawPayload || '');
  const context = {
    state_code: opts.state_code || opts.stateCode || 'ID',
    county: opts.county || '',
    facility: opts.facility || '',
    source_key: opts.source_key || opts.sourceKey || '',
    sourceUrl: opts.sourceUrl || opts.source_url || '',
    rawPayloadHash: sha256(raw),
    collectedAt: opts.collectedAt || new Date().toISOString(),
  };

  const json = tryJson(raw);
  if (json) return mapJsonPayload(json, context);

  const adaRows = mapAdaArrestBlocks(raw, context);
  if (adaRows.length) return adaRows;
  if (context.source_key === 'ada') return [];

  for (const embedded of extractEmbeddedJson(raw)) {
    const mapped = mapJsonPayload(embedded, context);
    if (mapped.length) return mapped;
  }

  const tableRows = mapHtmlTables(raw, context);
  const credibleTableRows = tableRows.filter((row) => row.booking_date || row.source_record_id || row.arresting_agency || row.charges_list.length > 1);
  if (credibleTableRows.length) return credibleTableRows;

  return mapTextCards(raw, context);
}

async function fetchAdaCountyRoster(source, opts = {}) {
  const sourceUrl = opts.sourceUrl || source.source_url;
  const first = await fetchWithRetry(sourceUrl, { ...opts, alwaysDelay: false });
  const letters = String(opts.letters || 'ABCDEFGHIJKLMNOPQRSTUVWXYZ').split('');
  const recordsByHash = new Map();
  let rawCombined = first.body;
  let lastPageHtml = first.body;

  for (const letter of letters) {
    const fields = extractHiddenFields(lastPageHtml);
    const body = new URLSearchParams();
    body.set('__EVENTTARGET', 'ctl00$ContentPlaceHolder1$btnFilter');
    body.set('__EVENTARGUMENT', '');
    for (const key of ['__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION']) {
      if (fields[key]) body.set(key, fields[key]);
    }
    body.set('ctl00$ContentPlaceHolder1$txtFilter', letter);
    body.set('ctl00$ContentPlaceHolder1$txtPersonID', '');

    const result = await fetchWithRetry(sourceUrl, {
      ...opts,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': sourceUrl,
        ...(opts.headers || {}),
      },
      body,
      alwaysDelay: true,
    });
    lastPageHtml = result.body;
    rawCombined += `\n<!-- blotter-host letter ${letter} -->\n` + result.body;
    const rows = mapIdahoRosterPayload(result.body, {
      sourceUrl,
      source_key: source.source_key,
      county: source.county,
      facility: source.facility,
      state_code: source.state_code || 'ID',
    });
    for (const row of rows) recordsByHash.set(row.record_hash, row);
  }

  return {
    ok: true,
    state_code: 'ID',
    source: {
      source_key: source.source_key || '',
      county: source.county || '',
      facility: source.facility || '',
      source_url: sourceUrl,
      status: 200,
    },
    collected_at: new Date().toISOString(),
    raw_payload: rawCombined,
    raw_payload_hash: sha256(rawCombined),
    records: Array.from(recordsByHash.values()),
    records_emitted: recordsByHash.size,
  };
}

async function fetchWithRetry(url, opts = {}) {
  const retries = Number.isFinite(opts.retries) ? opts.retries : DEFAULT_RETRIES;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const rateLimitMs = Number.isFinite(opts.rateLimitMs) ? opts.rateLimitMs : DEFAULT_RATE_LIMIT_MS;
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (attempt > 1 || opts.alwaysDelay) await sleep(rateLimitMs * attempt);
      const res = await fetch(url, {
        method: opts.method || 'GET',
        headers: {
          'User-Agent': opts.userAgent || DEFAULT_USER_AGENT,
          'Accept': 'text/html,application/json,text/plain,*/*',
          ...(opts.headers || {}),
        },
        body: opts.body,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from ${url}`);
        err.status = res.status;
        err.body = text.slice(0, 500);
        throw err;
      }
      return { body: text, status: res.status, headers: Object.fromEntries(res.headers.entries()) };
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error(`Failed to fetch ${url}`);
}

async function scrapeIdahoRoster(source = IDAHO_SOURCES.ada, opts = {}) {
  const target = typeof source === 'string' ? (IDAHO_SOURCES[source] || { source_url: source, county: opts.county || '', state_code: 'ID' }) : source;
  const sourceUrl = opts.sourceUrl || target.source_url || target.url;
  if (!sourceUrl) throw new Error('source_url is required');

  if ((target.source_key || opts.source_key) === 'ada') {
    return fetchAdaCountyRoster({ ...target, source_url: sourceUrl }, opts);
  }

  const fetched = await fetchWithRetry(sourceUrl, opts);
  const records = mapIdahoRosterPayload(fetched.body, {
    sourceUrl,
    source_key: target.source_key || opts.source_key || '',
    county: opts.county || target.county || '',
    facility: opts.facility || target.facility || '',
    state_code: opts.state_code || target.state_code || 'ID',
  });

  return {
    ok: true,
    state_code: 'ID',
    source: {
      source_key: target.source_key || '',
      county: opts.county || target.county || '',
      facility: opts.facility || target.facility || '',
      source_url: sourceUrl,
      status: fetched.status,
    },
    collected_at: new Date().toISOString(),
    raw_payload: fetched.body,
    raw_payload_hash: sha256(fetched.body),
    records,
    records_emitted: records.length,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source-key') out.sourceKey = argv[++i];
    else if (arg === '--source-url') out.sourceUrl = argv[++i];
    else if (arg === '--county') out.county = argv[++i];
    else if (arg === '--out') out.out = argv[++i];
    else if (arg === '--timeout-ms') out.timeoutMs = parseInt(argv[++i], 10);
    else if (arg === '--retries') out.retries = parseInt(argv[++i], 10);
    else if (arg === '--letters') out.letters = argv[++i];
    else if (arg === '--pretty') out.pretty = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = args.sourceUrl
    ? { source_key: args.sourceKey || 'custom', state_code: 'ID', county: args.county || '', source_url: args.sourceUrl }
    : IDAHO_SOURCES[args.sourceKey || 'ada'];
  if (!source) throw new Error(`Unknown source key: ${args.sourceKey}`);

  const result = await scrapeIdahoRoster(source, args);
  const json = JSON.stringify(result, null, args.pretty ? 2 : 0);
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, json + '\n');
  } else {
    process.stdout.write(json + '\n');
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify({
      ok: false,
      state_code: 'ID',
      error: err.message,
      collected_at: new Date().toISOString(),
    }) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  IDAHO_SOURCES,
  buildBailAdHook,
  extractAdaArrestBlocks,
  extractHiddenFields,
  fetchWithRetry,
  mapIdahoRosterPayload,
  normalizeBooking,
  scrapeIdahoRoster,
};
