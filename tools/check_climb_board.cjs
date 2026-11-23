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
      if (!['workspace.html', 'workspace.js', 'workspace.css'].includes(file))
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
    async function fixture(count, total, width = 1440) {
      await p.setViewportSize({ width, height: 1200 });
      await p.evaluate(
        ({ count, total }) => {
          const names = [
            'Александра Константиновна Вознесенская',
            'Alexander Konstantinov',
            'Мария Александровна Михайлова',
            'Anna Smirnova',
          ];
          const people = Array.from({ length: count }, (_, i) => ({
            nick:
              count === 1
                ? 'Александра Константиновна Вознесенская'
                : names[i % names.length] + ' · ' + (i + 1),
            rank: i + 1,
            correct:
              count === 1
                ? 2
                : Math.max(0, total - Math.floor(i / Math.max(1, count / (total + 1)))),
            score: count === 1 ? 372 : Math.max(0, 3000 - i * 17),
            connected: i % 13 !== 0,
            answeredThisRound: i % 2 === 0,
          }));
          boardQuery = '';
          boardCheckpoint = null;
          boardTopOnly = false;
          boardExpanded = false;
          boardMode = 'mountain';
          boardFocus = null;
          room = 'demo-room';
          page = 'lobby';
          state = {
            session: {
              status: 'running',
              stream: 2,
              total,
              metadata: { title: 'Graphs · Class demonstration' },
            },
            leaderboard: people,
            roster: people,
            attendance: [],
            round: 2,
            roundTotal: total,
            answeredCount: Math.floor(count / 2),
            qrSvg: '',
            joinUrl: 'https://example.org/join',
          };
          render();
        },
        { count, total }
      );
      assert.equal(await p.locator('.climb-student-row').count(), count);
      const groupSum = await p
        .locator('.climb-marker text')
        .evaluateAll((nodes) => nodes.reduce((n, e) => n + Number(e.textContent), 0));
      assert.equal(groupSum, count);
      assert.ok(
        (await p.locator('.climb-marker').count()) <= 31,
        'Markers must remain bounded even for 500 questions'
      );
      const layout = await p.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        scene: document.querySelector('.climb-scene').getBoundingClientRect().height,
        board: document.querySelector('.competition-board').getBoundingClientRect().height,
      }));
      assert.equal(layout.overflow, false);
      assert.ok(layout.scene > 200 && layout.scene <= 371);
      if (count === 1)
        assert.ok(
          layout.board < 900,
          'Single climber board must not contain an empty fixed-height area'
        );
      assert.equal(await p.locator('.mountain-live,.climber').count(), 0);
      const overlaps = await p
        .locator('.climb-student-name')
        .evaluateAll((nodes) => nodes.some((e) => e.scrollWidth > e.clientWidth + 1));
      assert.equal(overlaps, false, 'Full names must wrap');
    }
    for (const [count, total, width] of [
      [0, 30, 1440],
      [1, 10, 1440],
      [60, 30, 1440],
      [120, 30, 1440],
      [120, 500, 1440],
      [120, 30, 1024],
      [60, 30, 390],
    ])
      await fixture(count, total, width);
    await fixture(120, 30);
    await p.getByRole('button', { name: 'Top 10', exact: true }).click();
    assert.equal(await p.locator('.climb-student-row').count(), 10);
    await p.getByRole('button', { name: 'Show everyone', exact: true }).click();
    await p.getByRole('searchbox', { name: 'Find a climber' }).fill('Михайлова');
    assert.ok((await p.locator('.climb-student-row').count()) > 0);
    assert.ok((await p.locator('.climb-student-row').count()) < 120);
    await p.getByRole('button', { name: 'Clear search', exact: true }).click();
    await p.locator('.climb-marker[data-checkpoint="30"]').click();
    const filteredCount = await p.locator('.climb-student-row').count();
    assert.ok(filteredCount > 0 && filteredCount < 120);
    await p.getByRole('button', { name: /clear filter/ }).click();
    await p.locator('.climb-student-name').nth(7).click();
    assert.ok((await p.locator('.board-spotlight-name').textContent()).includes('8'));
    await p.getByRole('searchbox', { name: 'Find a climber' }).fill('Anna');
    await p.locator('.climb-leaderboard').evaluate((el) => (el.scrollTop = 180));
    await p.evaluate(() => {
      state.answeredCount++;
      render();
    });
    assert.equal(await p.getByRole('searchbox', { name: 'Find a climber' }).inputValue(), 'Anna');
    assert.ok(await p.locator('.climb-leaderboard').evaluate((el) => el.scrollTop > 0));
    assert.equal(await p.evaluate(() => document.activeElement.id), 'boardSearch');
    await p.getByRole('button', { name: 'Clear search', exact: true }).click();
    const initialEvents = await p.evaluate(() => events.size);
    await p.evaluate(() => {
      for (let i = 0; i < 30; i++) render();
    });
    assert.ok(
      (await p.evaluate(() => events.size)) < initialEvents + 5,
      'Repeated updates must not leak action handlers'
    );
    await p.getByRole('button', { name: 'Large view', exact: true }).click();
    assert.equal(await p.locator('.board-expanded').count(), 1);
    await p.keyboard.press('Escape');
    assert.equal(await p.locator('.board-expanded').count(), 0);
    await p.getByRole('button', { name: 'Leaderboard only', exact: true }).click();
    assert.equal(await p.locator('.climb-scene').count(), 0);
    await p.getByRole('button', { name: 'Show mountain', exact: true }).click();
    await fixture(1, 10);
    if (process.env.BOARD_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.BOARD_SCREENSHOT_DIR, { recursive: true });
      await p
        .locator('.competition-board')
        .screenshot({ path: path.join(process.env.BOARD_SCREENSHOT_DIR, 'climb-single.png') });
      await fixture(120, 30);
      await p
        .locator('.competition-board')
        .screenshot({ path: path.join(process.env.BOARD_SCREENSHOT_DIR, 'climb-large-class.png') });
    }
    assert.deepEqual(errors, []);
    console.log(
      'Climb board: 0/1/60/120 students; 10/30 questions; mobile/desktop, full names, checkpoint filters, search, spotlight, large view, live-update scroll/focus and bounded handlers passed.'
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
