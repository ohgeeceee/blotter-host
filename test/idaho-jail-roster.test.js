'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const scraper = require('../scrapers/idaho-jail-roster');

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

test('maps Idaho roster table HTML into the unified booking schema', () => {
  const records = scraper.mapIdahoRosterPayload(fixture('idaho-roster-table.html'), {
    sourceUrl: 'https://apps.adacounty.id.gov/sheriff/reports/inmates.aspx',
    county: 'Ada',
    state_code: 'ID',
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].arrestee_name, 'John Michael Doe');
  assert.equal(records[0].age, 34);
  assert.equal(records[0].booking_date, '2026-06-05');
  assert.equal(records[0].booking_time, '23:42');
  assert.deepEqual(records[0].charges_list, ['Burglary', 'Possession of Controlled Substance']);
  assert.equal(records[0].bail_amount, 25000);
  assert.equal(records[0].bond_type, 'Surety');
  assert.equal(records[0].mugshot_url, 'https://apps.adacounty.id.gov/mugshots/123.jpg');
  assert.equal(records[0].arresting_agency, 'Ada County Sheriff');
  assert.equal(records[0].monetization.bail_ad_hook.eligible, true);
});

test('maps Idaho roster JSON API payload into the unified booking schema', () => {
  const records = scraper.mapIdahoRosterPayload(fixture('idaho-roster-api.json'), {
    sourceUrl: 'https://jailroster.canyoncounty.id.gov/api/roster',
    county: 'Canyon',
    state_code: 'ID',
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].arrestee_name, 'Jane Smith');
  assert.equal(records[0].age, 28);
  assert.equal(records[0].booking_date, '2026-06-06');
  assert.equal(records[0].booking_time, '08:15');
  assert.deepEqual(records[0].charges_list, ['DUI', 'Driving Without Privileges']);
  assert.equal(records[0].bail_amount, 1500);
  assert.equal(records[0].bond_type, 'Cash or Surety');
  assert.equal(records[0].mugshot_url, 'https://example.test/mugshots/456.jpg');
  assert.equal(records[0].arresting_agency, 'Boise Police Department');
});

test('extracts bail ad targeting context without selecting an advertiser', () => {
  const hook = scraper.buildBailAdHook({
    county: 'Ada',
    state_code: 'ID',
    bail_amount: 7500,
    bond_type: 'Surety',
  });

  assert.deepEqual(hook, {
    slot: 'idaho_bail_bonds_feed',
    state_code: 'ID',
    county: 'Ada',
    bond_bucket: 'medium',
    bond_type: 'Surety',
    eligible: true,
    ad_query: {
      state_code: 'ID',
      county: 'Ada',
      min_bond_amount: 7500,
      package_tiers: ['standard', 'premium', 'exclusive'],
    },
  });
});

test('maps Ada County arrest blocks from official WebForms search results', () => {
  const records = scraper.mapIdahoRosterPayload(fixture('ada-arrest-block.html'), {
    sourceUrl: 'https://apps.adacounty.id.gov/sheriff/reports/inmates.aspx',
    county: 'Ada',
    facility: 'Ada County Jail',
    source_key: 'ada',
    state_code: 'ID',
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].source_record_id, '01114940');
  assert.equal(records[0].arrestee_name, 'Majid Rahdi Jelab Al Tubi');
  assert.equal(records[0].age, 32);
  assert.equal(records[0].booking_date, null);
  assert.deepEqual(records[0].charges_list, [
    'Battery-Aggravated',
    'Controlled Substance-Possession of Marijuana',
  ]);
  assert.equal(records[0].bail_amount, 150000);
  assert.equal(records[0].arresting_agency, 'Boise City Police Department');
  assert.equal(records[0].mugshot_url, '');
});

test('does not infer Ada County records from no-result boilerplate', () => {
  const records = scraper.mapIdahoRosterPayload(`
    <html><body>
      <h1>Roster Back To Top Inmates As Of</h1>
      <p>No Records Found for entered name above.</p>
      <p>Bond information is for charges where release is an option.</p>
    </body></html>
  `, {
    sourceUrl: 'https://apps.adacounty.id.gov/sheriff/reports/inmates.aspx',
    county: 'Ada',
    facility: 'Ada County Jail',
    source_key: 'ada',
    state_code: 'ID',
  });

  assert.deepEqual(records, []);
});
