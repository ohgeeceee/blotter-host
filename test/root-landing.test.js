'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { render } = require('../src/render/template');

test('root landing page surfaces user login, register, subscribe, and branding', () => {
  const html = render('root/landing.html', {
    NOTICE_HTML: '',
    ACTIVE_STATE_COUNT: 2,
    STATE_CARDS_HTML: '<article class="state-card">WA</article>',
    STATE_LIST_HTML: '<li class="state-pill">WA</li>',
    STATE_OPTIONS_HTML: '<option value="washington">Washington</option>',
  });

  assert.match(html, /Reader login/);
  assert.match(html, /Create account/);
  assert.match(html, /Subscribe/);
  assert.match(html, /exclusive public records network/i);
  assert.match(html, /Operators/);
  assert.match(html, /Washington/);
});

test('root auth page renders a public login/register surface', () => {
  const html = render('root/auth.html', {
    AUTH_TITLE: 'Login',
    AUTH_HINT: 'Sign in',
    AUTH_ACTION: '/login',
    STATE_OPTIONS_HTML: '<option value="washington">Washington</option>',
    STATE_CARDS_HTML: '<article class="state-card">WA</article>',
  });

  assert.match(html, /Login/);
  assert.match(html, /Operators/);
  assert.match(html, /clean way to follow state-level coverage/i);
  assert.match(html, /Washington/);
});

test('root network page lists the full state directory', () => {
  const html = render('root/network.html', {
    ACTIVE_STATE_COUNT: 2,
    STATE_CARDS_HTML: '<article class="state-card">WA</article>',
    STATE_LIST_HTML: '<li class="state-pill">WA</li>',
  });

  assert.match(html, /Network directory/);
  assert.match(html, /Browse every state/);
  assert.match(html, /WA/);
});

test('root about page explains the network', () => {
  const html = render('root/about.html', {
    ACTIVE_STATE_COUNT: 50,
  });

  assert.match(html, /About the network/);
  assert.match(html, /50/);
});
