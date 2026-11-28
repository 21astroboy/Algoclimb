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
      page = 'analytics';
      reportTab = 'overview';
      report = {
        session: { title: 'Labels fixture', date: '2026-11-24' },
        questions: Array.from({ length: 30 }, (_, i) => ({
          id: 'q' + i,
          title: 'Question ' + (i + 1),
          type: 'choice',
          correctAnswer: 'B',
        })),
        participants: [{ nick: 'Demo' }],
        results: [],
        checks: [],
        events: [],
        answers: [
          { task_id: 'q0', nick: 'Demo', correct: true },
          { task_id: 'q0', nick: 'Other', correct: false },
          { task_id: 'q1', nick: 'Demo', correct: true },
          { task_id: 'q2', nick: 'Demo', correct: false },
        ],
      };
      render();
    });
    assert.deepEqual(await p.locator('.accuracy-value').allTextContents(), [
      '50%',
      '100%',
      '0%',
      ...Array(27).fill('—'),
    ]);
    assert(
      (await p.locator('.accuracy-bars button').first().getAttribute('aria-label')).includes(
        '1/2 correct'
      )
    );
    await p.setViewportSize({ width: 390, height: 844 });
    assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert(await p.locator('.accuracy-chart').evaluate((el) => el.scrollWidth > el.clientWidth));
    await p.locator('.accuracy-bars button').first().click();
    assert.equal(await p.evaluate(() => reportTab), 'question');
    assert.deepEqual(errors, []);
    console.log(
      'Chart labels: 50%, 100%, 0%, no submissions, accessible descriptions and 30-question mobile scrolling passed'
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
