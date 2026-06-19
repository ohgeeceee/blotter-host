'use strict';

const { ingestDynamicPage } = require('../dynamic');

async function runBatch(input, deps = {}) {
  if (!input.sourceUrl && !input.url) {
    throw new Error('sourceUrl is required for dynamicBulletin strategy');
  }
  return ingestDynamicPage(input, deps);
}

module.exports = {
  runBatch,
};
