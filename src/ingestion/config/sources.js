'use strict';

module.exports = [
  {
    state: 'idaho',
    type: 'jail_roster',
    strategy: 'staticRoster',
    url: 'https://example-idaho-county-roster.gov/inmates',
    selectors: {
      row: '.inmate-row',
      columns: ['.name', '.date', '.charges'],
    },
  },
  {
    state: 'washington',
    type: 'police_blotter',
    strategy: 'apiRoster',
    url: 'https://api.example-wa-safety.gov/v1/feed',
    mapping: {
      name: 'full_name',
      charges: 'offense_desc',
      date: 'book_date',
    },
  },
  ...require('./sources-california'),
  ...require('./sources-states'),
];
