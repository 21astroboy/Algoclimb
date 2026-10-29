// Visual regression fixture: run tools/demo_server.py first. No production connections.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ channel: process.env.SCREENSHOT_BROWSER || undefined });
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        if ((await fetch('http://127.0.0.1:8098/healthz')).ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('http://127.0.0.1:8098/teacher');
    await page.locator('#keyInput').fill('LOCAL-DEMO-ONLY');
    await page.locator('#keyForm button').click();
    await page.locator('.catrow').first().waitFor({ state: 'attached' });
    // Freeze networking for the deterministic 72-person / 30-question display fixture.
    await page.evaluate(() => {
      ws.onclose = null;
      ws.onmessage = null;
      ws.close();
      const surnames = ['Александрова-Рождественская', 'Константинопольский', "O'Connor-MacDonald", 'Петрова'];
      const rows = Array.from({ length: 72 }, (_, i) => ({
        rank: i + 1, nick: `${surnames[i % surnames.length]} Екатерина Константиновна ${i + 1}`,
        icon: ['🦉', '🦊', '🐙', '🐧'][i % 4], correct: i % 31,
        score: (72 - i) * 100, tabLeaves: i % 3, fastAnswers: i % 4,
        connected: true, answeredThisRound: i % 2 === 0, answers: [],
      }));
      state = { session: { status: 'running', total: 30 }, leaderboard: rows };
      TOTAL = 30;
      document.querySelector('.wrap').classList.add('competition');
      document.getElementById('lobbyView').classList.add('hidden');
      document.getElementById('gameView').classList.remove('hidden');
      document.getElementById('startBtn').classList.add('hidden');
      document.getElementById('testBtn').classList.add('hidden');
      document.getElementById('finishBtn').classList.remove('hidden');
      document.getElementById('qnum').textContent = 'Question 16/30';
      document.getElementById('answered').textContent = '36/72 answered';
      document.getElementById('timer').textContent = '00:28';
      buildMountain(rows);
      buildLB(rows, true);
    });
    for (const width of [1920, 1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 1080 });
      await page.waitForTimeout(100);
      const layout = await page.evaluate(() => {
        const badges = [...document.querySelectorAll('.stage-badge')].map((el) => el.getBoundingClientRect());
        let overlaps = 0;
        for (let a = 0; a < badges.length; a++) for (let b = a + 1; b < badges.length; b++) {
          const x = badges[a], y = badges[b];
          if (Math.min(x.right, y.right) > Math.max(x.left, y.left) &&
              Math.min(x.bottom, y.bottom) > Math.max(x.top, y.top)) overlaps++;
        }
        const names = [...document.querySelectorAll('.nick')];
        return {
          rows: document.querySelectorAll('.lbrow').length, overlaps,
          clipped: names.filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1).length,
          font: getComputedStyle(names[0]).fontSize,
          mountainWidth: document.getElementById('mountain').getBoundingClientRect().width,
          leaderboardTop: document.getElementById('lb').getBoundingClientRect().top,
          mountainBottom: document.getElementById('mountain').getBoundingClientRect().bottom,
          counts: [...document.querySelectorAll('.stage-badge b')].reduce((sum, el) => sum + Number(el.textContent), 0),
        };
      });
      assert.equal(layout.rows, 72);
      assert.equal(layout.counts, 72);
      assert.equal(layout.overlaps, 0, `overlapping groups at width ${width}`);
      assert.equal(layout.clipped, 0, `clipped names at width ${width}`);
      assert.equal(layout.font, '18px');
      assert.ok(layout.leaderboardTop > layout.mountainBottom);
      assert.ok(layout.mountainWidth > width * .85);
      console.log(`72 students, 30 checkpoints, ${width}px: no overlap or clipped names`);
    }
    await page.setViewportSize({ width: 1440, height: 1700 });
    await page.waitForTimeout(100);
    await page.screenshot({ path: path.join(__dirname, '..', 'docs/images/teacher-large-class.png') });
    // A group of 72 at one checkpoint must be counted without growing into its neighbors.
    await page.evaluate(() => {
      state.leaderboard.forEach((row) => { row.correct = 0; });
      buildMountain(state.leaderboard);
    });
    assert.equal(await page.locator('.stage-badge').count(), 1);
    assert.equal(await page.locator('.stage-badge b').textContent(), '72');
    const fullName = await page.locator('.nick').nth(2).textContent();
    const dialogHandled = new Promise((resolve) => page.once('dialog', async (dialog) => {
      assert.ok(dialog.message().includes(fullName));
      await dialog.dismiss();
      resolve();
    }));
    await page.locator('[data-kick]').nth(2).click();
    await dialogHandled;
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
