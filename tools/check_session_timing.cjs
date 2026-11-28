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
      room = 'fixture';
      state = {
        session: {
          status: 'lobby',
          reveal: 'teacher',
          preparation: {
            title: 'Prepared fixture',
            stream: 7,
            taskIds: ['fixture-question'],
            timeLimits: { choice: 45 },
          },
        },
      };
      api = async (_url, data) => {
        window.savedTiming = data;
        return {};
      };
      openRoom = async () => {};
      configure();
    });
    await p.locator('summary').click();
    assert.equal(await p.locator('#sessionTitle').inputValue(), 'Prepared fixture');
    assert.equal(await p.locator('#classGroup').inputValue(), '7');
    assert.equal(await p.locator('#revealMode').inputValue(), 'teacher');
    assert.equal(await p.locator('#time-choice').inputValue(), '45');
    assert.equal(await p.locator('#time-sort').getAttribute('required'), null);
    await p.locator('#time-graph').fill('4');
    await p.getByRole('button', { name: 'Open lobby', exact: true }).click();
    await p.locator('#formError:not([hidden])').waitFor();
    assert.equal(await p.evaluate(() => window.savedTiming), undefined);
    await p.locator('#time-graph').fill('120');
    await p.getByRole('button', { name: 'Open lobby', exact: true }).click();
    await p.waitForFunction(() => window.savedTiming);
    assert.deepEqual(await p.evaluate(() => window.savedTiming.timeLimits), {
      choice: 45,
      graph: 120,
    });
    assert.deepEqual(await p.evaluate(() => window.savedTiming.taskIds), ['fixture-question']);
    await p.setViewportSize({ width: 390, height: 844 });
    await p.evaluate(() => configure());
    await p.locator('summary').click();
    assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await p.locator('#time-choice').fill('');
    await p.getByRole('button', { name: 'Open lobby', exact: true }).click();
    await p.waitForFunction(() => Object.keys(window.savedTiming.timeLimits).length === 0);
    assert.deepEqual(errors, []);
    console.log(
      'Timing UI: optional fields, restored values, validation, saved overrides and mobile layout passed'
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
