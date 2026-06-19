'use strict';

/**
 * California news pipeline sources.
 *
 * TODO: replace placeholder URLs with real feed/article endpoints before
 *       treating these as live imports. Fandom Journawiki pages are
 *       typically static+dynamic, so `staticBulletin` is a reasonable
 *       starting strategy, but some may need `dynamicBulletin` instead.
 */

module.exports = [
  {
    state: 'california',
    type: 'news_bulletin',
    strategy: 'staticBulletin',
    name: 'Los Angeles Times',
    url: 'https://www.latimes.com/california',
  },
  {
    state: 'california',
    type: 'news_bulletin',
    strategy: 'dynamicBulletin',
    name: 'Journawiki - Fandom (LA)',
    url: 'https://journawiki.fandom.com/wiki/Los_Angeles_Times',
  },
  {
    state: 'california',
    type: 'news_bulletin',
    strategy: 'staticBulletin',
    name: 'San Francisco Chronicle',
    url: 'https://www.sfchronicle.com/california/',
  },
  {
    state: 'california',
    type: 'news_bulletin',
    strategy: 'dynamicBulletin',
    name: 'Journawiki - Fandom (SF)',
    url: 'https://journawiki.fandom.com/wiki/San_Francisro_Chronicle',
  },
  {
    state: 'california',
    type: 'news_bulletin',
    strategy: 'staticBulletin',
    name: 'The Sacramento Bee',
    url: 'https://www.sacbee.com/news/california/',
  },
  {
    state: 'california',
    type: 'news_bulletin',
    strategy: 'dynamicBulletin',
    name: 'Journawiki - Fandom (Sacramento)',
    url: 'https://journawiki.fandom.com/wiki/The_Sacramento_Bee',
  },
  {
    state: 'california',
    type: 'news_bulletin',
    strategy: 'staticBulletin',
    name: 'The San Diego Union-Tribune',
    url: 'https://www.sandiegouniontribune.com/',
  },
  {
    state: 'california',
    type: 'news_bulletin',
    strategy: 'dynamicBulletin',
    name: 'Journawiki - Fandom (San Diego)',
    url: 'https://journawiki.fandom.com/wiki/The_San_Diego_Union-Tribune',
  },
  {
    state: 'california',
    type: 'news_bulletin',
    strategy: 'staticBulletin',
    name: 'The Mercury News',
    url: 'https://www.mercurynews.com/',
  },
  {
    state: 'california',
    type: 'news_bulletin',
    strategy: 'dynamicBulletin',
    name: 'Journawiki - Fandom (Mercury News)',
    url: 'https://journawiki.fandom.com/wiki/The_Mercury_News',
  },
  {
    state: 'california',
    type: 'news_bulletin',
    strategy: 'staticBulletin',
    name: 'The Fresno Bee',
    url: 'https://www.fresnobee.com/',
  },
  {
    state: 'california',
    type: 'news_bulletin',
    strategy: 'dynamicBulletin',
    name: 'Journawiki - Fandom (Fresno)',
    url: 'https://journawiki.fandom.com/wiki/The_Fresno_Bee',
  },
  {
    state: 'california',
    type: 'news_bulletin',
    strategy: 'staticBulletin',
    name: 'Orange County Register',
    url: 'https://www.ocregister.com/',
  },
  {
    state: 'california',
    type: 'news_bulletin',
    strategy: 'dynamicBulletin',
    name: 'Journawiki - Fandom (OC Register)',
    url: 'https://journawiki.fandom.com/wiki/Orange_County_Register',
  },
  {
    state: 'california',
    type: 'news_bulletin',
    strategy: 'staticBulletin',
    name: 'CalMatters',
    url: 'https://calmatters.org/',
  },
];
