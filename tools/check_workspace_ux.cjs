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

    const primary = p.getByRole('button', { name: 'Create session', exact: true }).first();
    await p.mouse.move(0, 0);
    const normal = await primary.evaluate((el) => getComputedStyle(el).backgroundColor);
    await primary.hover();
    await p.waitForTimeout(170);
    const hover = await primary.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.notEqual(normal, hover);
    await p.mouse.down();
    await p.waitForTimeout(170);
    const pressed = await primary.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.notEqual(hover, pressed);
    await p.mouse.move(0, 0);
    await p.mouse.up();
    await p.getByRole('button', { name: 'Question library', exact: true }).click();
    await p.getByRole('heading', { name: 'Question library', exact: true }).waitFor();
    await p.getByRole('button', { name: '← Back', exact: true }).click();
    await p.getByRole('heading', { name: 'Welcome, Demo Teacher' }).waitFor();
    await p.getByRole('button', { name: 'My sessions', exact: true }).click();
    await p.locator('[data-home]').click();
    await p.getByRole('heading', { name: 'Welcome, Demo Teacher' }).waitFor();
    await p.evaluate(() => {
      report = {
        session: { title: 'Fixture', date: '2026-11-24' },
        participants: [{ nick: 'Demo Student' }],
        questions: [],
        answers: [],
        results: [{ nick: 'Demo Student', place: 1, total: 50 }],
        checks: [],
        events: [{ nick: 'Demo Student', kind: 'tableave', at: '2026-11-24T10:00:00' }],
      };
      page = 'analytics';
      reportTab = 'leaderboard';
      render();
    });
    assert(await p.getByRole('columnheader', { name: 'Tab leaves', exact: true }).count());
    await p.getByRole('button', { name: 'View all answers', exact: true }).click();
    assert.equal(await p.evaluate(() => reportTab), 'student');
    assert.equal(await p.evaluate(() => tabLeaveCount('Demo Student')), 1);
    await p.getByRole('button', { name: '← Back', exact: true }).click();
    assert.equal(await p.evaluate(() => reportTab), 'students');
    await p.getByRole('button', { name: 'Connections', exact: true }).click();
    await p.getByText('1 tab leaves recorded', { exact: true }).waitFor();
    await p.evaluate(() => {
      report = null;
      page = 'home';
      room = null;
      state = null;
      render();
      configure();
    });
    assert.equal(await p.locator('#app').evaluate((el) => el.inert), true);
    const close = p.getByRole('button', { name: '← Back / Close', exact: true });
    await close.focus();
    await p.keyboard.press('Shift+Tab');
    assert.equal(await p.evaluate(() => document.activeElement.textContent), 'Open lobby');
    await p.keyboard.press('Tab');
    assert.equal(await p.evaluate(() => document.activeElement.textContent), '← Back / Close');
    await p.locator('#geoEnabled').check();
    await p.locator('#geoRadius').waitFor({ state: 'visible' });
    await p.locator('#geoEnabled').uncheck();
    await p.locator('#geoRadius').waitFor({ state: 'hidden' });
    await p.locator('#sessionTitle').fill('Graphs · Seminar 5');
    await p.locator('summary').click();
    await p.screenshot({ path: '/tmp/algoclimb-session-setup-desktop.png' });
    await p.keyboard.press('Escape');
    assert.equal(await p.getByRole('dialog').count(), 0);
    assert.equal(await p.locator('#app').evaluate((el) => el.inert), false);
    await p.setViewportSize({ width: 390, height: 844 });
    await p.evaluate(() => configure());
    await p.locator('summary').click();
    assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await p.screenshot({ path: '/tmp/algoclimb-session-setup-mobile.png' });
    assert.deepEqual(errors, []);
    console.log(
      'Workspace UX: hover, pressed state, back, logo, nested report navigation, tab-leave counters, form and mobile layout passed'
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
