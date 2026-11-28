const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
async function fixture(fail = false) {
  const stored = new Map([['ac.language', 'ru']]);
  const context = vm.createContext({
    window: {},
    AbortController,
    setTimeout,
    clearTimeout,
    document: { documentElement: { lang: 'en' } },
    localStorage: { getItem: (k) => stored.get(k), setItem: (k, v) => stored.set(k, v) },
    fetch: async () => ({
      ok: !fail,
      json: async () => JSON.parse(fs.readFileSync('frontend/locales/ru.json', 'utf8')),
    }),
  });
  vm.runInContext(fs.readFileSync('frontend/i18n.js', 'utf8'), context);
  await context.window.ACI18n.ready;
  return context;
}
test('only static interface text is translated; user content and technical attributes stay unchanged', async () => {
  const c = await fixture();
  const html = vm.runInContext(
    'window.ACI18n.html`<div class="correct"><h2>Question library</h2><p>${"Overview"}</p><input id="questionSearch" placeholder="Search question titles"></div>`',
    c
  );
  assert(html.includes('Библиотека вопросов'));
  assert(html.includes('<p>Overview</p>'));
  assert(html.includes('class="correct"'));
  assert(html.includes('id="questionSearch"'));
  assert(html.includes('placeholder="Поиск по названиям вопросов"'));
});
test('language can round-trip without changing stored messages', async () => {
  const c = await fixture();
  const api = c.window.ACI18n;
  assert.equal(api.language, 'ru');
  assert.equal(api.t('Overview'), 'Обзор');
  api.setLanguage('en');
  assert.equal(api.t('Overview'), 'Overview');
  api.setLanguage('ru');
  assert.equal(c.document.documentElement.lang, 'ru');
});
test('unavailable dictionary leaves the application usable in English', async () => {
  const c = await fixture(true);
  assert.equal(c.window.ACI18n.language, 'en');
  assert.equal(c.window.ACI18n.t('Overview'), 'Overview');
});
