// Deterministic UI fixture. No VPS, private bank, credentials or live class connections.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    channel: process.env.SCREENSHOT_BROWSER || undefined,
  });
  try {
    const p = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.route('https://climb.test/**', async (route) => {
      const url = new URL(route.request().url());
      const pathname = url.pathname;
      if (pathname.startsWith('/api/workspace')) {
        const data = pathname.endsWith('/me')
          ? {
              id: 'demo',
              role: 'admin',
              name: 'Demo Teacher',
              email: 'demo@example.org',
              sections: ['graphs'],
              subject: 'Graphs',
            }
          : pathname.endsWith('/catalog')
            ? { sections: { graphs: 'Graphs' }, tasks: [] }
            : [];
        return route.fulfill({ json: data });
      }
      const file = pathname === '/workspace' ? 'workspace.html' : pathname.slice(1);
      if (
        ![
          'workspace.html',
          'workspace.js',
          'workspace.css',
          'interactions.css',
          'site-footer.js',
          'i18n.js',
          'locales/ru.json',
        ].includes(file)
      )
        return route.fulfill({ status: 404, body: '' });
      return route.fulfill({
        contentType: file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : 'text/html',
        body: fs.readFileSync(path.join(root, 'frontend', file), 'utf8'),
      });
    });
    await p.goto('https://climb.test/workspace');
    await p.getByRole('heading', { name: 'Welcome, Demo Teacher' }).waitFor();

    await p.evaluate(() => {
      catalog = {
        sections: { graphs: 'Graphs', oop: 'OOP' },
        tasks: Array.from({ length: 8 }, (_, i) => ({
          id: 'task-' + i,
          title: i === 0 ? 'Overview' : 'Question ' + i,
          prompt: 'Student answer remains unchanged',
          section: i === 7 ? 'oop' : 'graphs',
          set: i === 6 ? 'personal-demo' : 'graphs1',
          setName: 'Demo set',
          type: i % 2 ? 'graph' : 'choice',
          level: (i % 3) + 1,
        })),
      };
      page = 'library';
      render();
    });
    await p.locator('[data-pick="task-0"]').check();
    await p.locator('[data-pick="task-1"]').check();
    assert.equal(await p.locator('#selectionCount').textContent(), 'Questions · 2 selected');
    await p.locator('[data-pick="task-0"]').uncheck();
    assert.equal(await p.locator('#selectionCount').textContent(), 'Questions · 1 selected');
    await p.locator('#randomCount').fill('0');
    await p.getByRole('button', { name: 'Preview random sample', exact: true }).click();
    await p.getByText('Enter a whole sample size from 1 to 500.', { exact: true }).waitFor();
    assert.equal(await p.locator('#libraryAdvanced').getAttribute('open'), null);
    await p.locator('#libraryAdvanced summary').click();
    await p.locator('#libraryType').selectOption('choice');
    await p.locator('#libraryLevel').selectOption('1');
    await p.locator('#librarySource').selectOption('builtin');
    await p.getByRole('button', { name: 'Apply filters', exact: true }).click();
    assert.deepEqual(
      await p.locator('[data-pick]').evaluateAll((nodes) => nodes.map((n) => n.dataset.pick)),
      ['task-0']
    );
    await p.locator('#randomCount').fill('2');
    await p.getByRole('button', { name: 'Preview random sample', exact: true }).click();
    await p
      .getByText(
        'The sample is larger than the filtered question pool. Reduce the sample size or change filters.',
        { exact: true }
      )
      .waitFor();
    await p.locator('#randomCount').fill('1');
    await p.getByRole('button', { name: 'Preview random sample', exact: true }).click();
    await p.getByRole('button', { name: 'Add to selection', exact: true }).click();
    assert.equal(await p.locator('#selectionCount').textContent(), 'Questions · 2 selected');
    await p.getByRole('button', { name: 'Preview random sample', exact: true }).click();
    await p.getByRole('button', { name: 'Replace selection', exact: true }).click();
    assert.equal(await p.locator('#selectionCount').textContent(), 'Questions · 1 selected');
    await p.getByRole('button', { name: 'Русский', exact: true }).click();
    await p.getByRole('heading', { name: 'Библиотека вопросов', exact: true }).waitFor();
    assert.equal(await p.locator('#selectionCount').textContent(), 'Вопросы · 1 выбрано');
    // Dynamic task titles must not be translated, even if they equal a UI message.
    assert(
      await p
        .locator('td')
        .filter({ hasText: /^Overview$/ })
        .count()
    );
    assert.equal(await p.locator('[data-pick="task-0"]').isChecked(), true);
    await p.locator('[data-pick="task-0"]').uncheck();
    assert.equal(await p.locator('#selectionCount').textContent(), 'Вопросы · 0 выбрано');
    assert.equal(await p.evaluate(() => document.documentElement.lang), 'ru');
    await p.reload();
    await p.getByRole('heading', { name: /Здравствуйте/ }).waitFor();
    await p.getByRole('button', { name: 'English', exact: true }).click();
    await p.getByRole('heading', { name: 'Welcome, Demo Teacher' }).waitFor();
    await p.evaluate(() => {
      catalog = {
        sections: { graphs: 'Graphs' },
        tasks: Array.from({ length: 700 }, (_, i) => ({
          id: 'large-' + i,
          title: 'Demo ' + i,
          prompt: 'Fixture',
          type: 'choice',
          level: 1,
          section: 'graphs',
          set: 'large',
          setName: 'Large fixture',
        })),
      };
      page = 'library';
      picked = new Set();
      libraryType = libraryLevel = librarySource = '';
      setFilter = '';
      render();
    });
    await p.locator('#randomCount').fill('100');
    await p.getByRole('button', { name: 'Preview random sample', exact: true }).click();
    assert.equal(await p.locator('[role=dialog] li').count(), 100);
    await p.getByRole('button', { name: 'Replace selection', exact: true }).click();
    assert.equal(await p.evaluate(() => picked.size), 100);
    await p.getByRole('button', { name: 'Preview random sample', exact: true }).click();
    await p.evaluate(() => {
      catalog.tasks = [];
    });
    await p.getByRole('button', { name: 'Replace selection', exact: true }).click();
    await p
      .getByText(
        'Some sampled questions are no longer available. Refresh the library and try again.',
        { exact: true }
      )
      .waitFor();
    assert.equal(await p.evaluate(() => picked.size), 100);
    await p.keyboard.press('Escape');
    await p.evaluate(() => render());
    await p.locator('#randomCount').fill('1');
    await p.getByRole('button', { name: 'Preview random sample', exact: true }).click();
    await p
      .getByText(
        'The sample is larger than the filtered question pool. Reduce the sample size or change filters.',
        { exact: true }
      )
      .waitFor();
    await p.evaluate(() => {
      report = {
        session: { id: 44, title: 'Графы / поток 2', stream: 2, date: '2026-11-26' },
        results: [{ place: 1, nick: 'Demo', total: 100 }],
        checks: [],
      };
    });
    const filename = await p.evaluate(() => reportFilename());
    assert(
      filename.includes('поток 2') && filename.includes('group-2') && filename.endsWith('_all.csv')
    );
    assert(!/[\/:*?"<>|]/.test(filename));
    await p.evaluate(() => exportReport());
    const downloadPromise = p.waitForEvent('download');
    await p.getByRole('button', { name: 'All participants · CSV', exact: true }).click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), filename);
    assert.deepEqual(errors, []);
    console.log(
      'Library/export/i18n: live checkbox count, scoped filters, random bounds/add/replace, language persistence, unchanged task content and actual download filename passed'
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
