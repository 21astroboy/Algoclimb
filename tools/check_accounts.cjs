/* Isolated real-browser regression; start a fresh server with LOCAL-TEST-ONLY key. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const base = process.env.WORKSPACE_TEST_URL || 'http://127.0.0.1:8099';
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    channel: process.env.SCREENSHOT_BROWSER || undefined,
  });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base + '/workspace');
    const initialized = (await (await ctx.request.get(base + '/api/workspace/status')).json())
      .initialized;
    if (!initialized) {
      await p.locator('#bootstrapKey').fill('LOCAL-TEST-ONLY');
      await p.locator('#authName').fill('Demo Owner');
      await p.locator('#authSubject').fill('Algorithms and Graphs');
    }
    await p.locator('#authEmail').fill('owner@example.org');
    await p.locator('#authPassword').fill('local-test-password-123');
    await p.locator('#authForm button').click();
    await p.getByRole('heading', { name: 'Welcome, Demo Owner' }).waitFor();
    const task = {
      id: 'stack',
      title: 'Stack discipline',
      prompt: 'Which rule does a stack follow?',
      type: 'choice',
      options: ['LIFO', 'FIFO'],
      answer: 0,
      section: 'algorithms',
      timeLimit: 30,
    };
    const imported = await (
      await ctx.request.post(base + '/api/workspace/import', {
        data: { title: 'Browser class', section: 'algorithms', mode: 'once', tasks: [task] },
      })
    ).json();
    await ctx.request.post(base + '/api/workspace/rooms/' + imported.room + '/settings', {
      data: { title: 'Browser class', reveal: 'after' },
    });
    await p.evaluate(
      ({ id, importId }) => {
        localStorage.setItem('ac.prep.' + id, JSON.stringify({ title: 'Browser class', importId }));
        return openRoom(id);
      },
      { id: imported.room, importId: imported.import_id }
    );
    await p.getByRole('button', { name: 'Start session', exact: true }).waitFor();
    const studentCtx = await browser.newContext();
    const student = await studentCtx.newPage();
    student.on('pageerror', (e) => errors.push(e.message));
    await student.goto(base + '/?room=' + imported.room);
    await student.locator('#nick').fill('Student browser');
    await student.locator('#joinBtn').click();
    await student.locator('#lobby').waitFor({ state: 'visible' });
    await p.getByText('Student browser', { exact: true }).waitFor();
    await p.getByRole('button', { name: 'Start session', exact: true }).click();
    await student.getByRole('button', { name: 'LIFO', exact: true }).click();
    await student.locator('#done').waitFor({ state: 'visible' });
    await p.getByRole('button', { name: 'Open saved report' }).waitFor();
    await p.getByRole('button', { name: 'Open saved report' }).click();
    await p.getByRole('button', { name: 'Report', exact: true }).first().click();
    for (const tab of ['Leaderboard', 'Students', 'Questions', 'Connections', 'Overview']) {
      await p.locator('.tabs').getByRole('button', { name: tab, exact: true }).click();
      assert.equal(await p.locator('.modalback').count(), 0);
    }
    await p.locator('.tabs').getByRole('button', { name: 'Leaderboard', exact: true }).click();
    await p.getByRole('button', { name: 'View all answers', exact: true }).click();
    assert.ok((await p.locator('article').textContent()).includes('LIFO'));
    await p.getByRole('button', { name: 'Question statistics', exact: true }).click();
    assert.ok((await p.locator('main').textContent()).includes('Response distribution'));
    // Manual invitations, private bank isolation and cookie authentication.
    const invite = await (
      await ctx.request.post(base + '/api/workspace/admin/invite', {
        data: { email: 'teacher-' + Date.now() + '@example.org', sections: ['algorithms'] },
      })
    ).json();
    const tc = await browser.newContext();
    const t = await tc.newPage();
    await t.goto(base + '/workspace#invite=' + invite.token);
    await t.locator('#authName').fill('Guest Teacher');
    await t.locator('#authSubject').fill('Algorithms');
    await t.locator('#authPassword').fill('guest-test-password');
    await t.locator('#authForm button').click();
    await t.getByRole('heading', { name: 'Welcome, Guest Teacher' }).waitFor();
    assert.equal(await t.getByRole('button', { name: 'Administration', exact: true }).count(), 0);
    const sessions = await (await tc.request.get(base + '/api/workspace/sessions')).json();
    assert.deepEqual(sessions, []);
    assert.deepEqual(errors, []);
    await ctx.close();
    await studentCtx.close();
    await tc.close();
    console.log(
      'Owner bootstrap, personal invite activation, real session, saved answers, 5 analytics tabs and teacher isolation passed.'
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
