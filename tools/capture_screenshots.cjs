// Start `python tools/demo_server.py` first. All clients use the local demo only.
const { chromium } = require('playwright');
const WebSocket = require('ws');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:8098';
const root = path.join(__dirname, '..');
const out = path.join(root, 'docs', 'images');
const tasks = JSON.parse(fs.readFileSync(path.join(root, 'backend/data/task-bank.example.json')));
const errors = [];
const bots = [];
let browser;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function bot(nick, icon) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/');
  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'join', nick, icon }));
  const peer = { ws, messages, nick };
  bots.push(peer);
  await wait(peer, 'joined');
  return peer;
}
async function wait(peer, type, predicate = () => true) {
  for (let i = 0; i < 100; i++) {
    const idx = peer.messages.findIndex((m) => m.type === type && predicate(m));
    if (idx >= 0) return peer.messages.splice(idx, 1)[0];
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${peer.nick}: ${type}`);
}
async function shot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  const viewport = page.viewportSize();
  const wrap = await page.locator('.wrap').boundingBox();
  const framing = viewport.width > 1000 ? {
    clip: { x: 0, y: 0, width: viewport.width,
      height: Math.min(viewport.height, Math.max(720, Math.ceil(wrap.y + wrap.height + 24))) },
  } : { fullPage: true };
  await page.screenshot({ path: path.join(out, name + '.png'), ...framing });
}
async function drawTriangle(page) {
  const box = await page.locator('#graph').boundingBox();
  const radius = Math.min(box.width, box.height) / 2 - 40;
  const points = [0, 1, 2].map((i) => {
    const angle = -Math.PI / 2 + i * 2 * Math.PI / 3;
    return { x: box.x + box.width / 2 + radius * Math.cos(angle),
      y: box.y + box.height / 2 + radius * Math.sin(angle) };
  });
  for (const [a, b] of [[0, 1], [1, 2], [0, 2]]) {
    await page.mouse.move(points[a].x, points[a].y);
    await page.mouse.down();
    await page.mouse.move(points[b].x, points[b].y, { steps: 8 });
    await page.mouse.up();
  }
}
(async () => {
  fs.mkdirSync(out, { recursive: true });
  browser = await chromium.launch({ channel: process.env.SCREENSHOT_BROWSER || undefined });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const teacher = await desktop.newPage();
  const student = await mobile.newPage();
  for (const p of [teacher, student]) p.on('pageerror', (e) => errors.push(e.message));
  await teacher.goto(base + '/teacher');
  await teacher.locator('#keyInput').fill('LOCAL-DEMO-ONLY');
  await teacher.locator('#keyForm button').click();
  await teacher.locator('.catrow').first().waitFor({ state: 'attached' });
  await teacher.evaluate(() => ws.send(JSON.stringify({ type: 'reset' })));
  await teacher.locator('#lobbyView').waitFor({ state: 'visible' });
  await student.goto(base);
  await student.locator('#nick').fill('Ada');
  await student.locator('#joinBtn').click();
  await student.locator('#lobby').waitFor({ state: 'visible' });
  await bot('Grace', '🦉'); await bot('Alan', '🐧'); await bot('Edsger', '🐙');
  await bot('Barbara', '🐝'); await bot('Donald', '🦁');
  await teacher.waitForFunction(() => document.getElementById('cnt').textContent === '6');
  await teacher.locator('#catAll').click();
  await shot(teacher, 'teacher-lobby');
  await teacher.locator('#startBtn').click();
  await student.locator('.opt').first().waitFor();
  await shot(student, 'student-choice');

  // Pause and retry are tested through actual controls, then an invalid answer
  // exercises the recovery path before the real answer is submitted.
  await teacher.locator('#pauseBtn').click();
  await student.waitForFunction(() => document.querySelector('.opt').disabled);
  await teacher.locator('#pauseBtn').click();
  await student.waitForFunction(() => !document.querySelector('.opt').disabled);
  await student.evaluate(() => ws.send(JSON.stringify({ type: 'answer', taskId: curTask.id, payload: { choice: -1 } })));
  await student.waitForFunction(() => document.getElementById('fb').textContent.includes('Invalid answer'));
  assert.equal(await student.locator('.opt:disabled').count(), 0);

  for (let round = 0; round < tasks.length; round++) {
    const source = tasks[round];
    for (const peer of bots) {
      const { task } = await wait(peer, 'task', (m) => m.task.id === source.id);
      let payload;
      if (task.type === 'choice') {
        const index = task.options.indexOf(source.options[source.answer]);
        payload = { choice: peer.nick === 'Alan' ? (index + 1) % task.options.length : index };
      } else if (task.type === 'graph') payload = { edges: source.requiredEdges || source.example };
      else if (task.type === 'order') payload = { order: ['A', 'B', 'C', 'D', 'E'] };
      else payload = { array: source.expected };
      peer.ws.send(JSON.stringify({ type: 'answer', taskId: task.id, payload }));
      await wait(peer, 'answered');
    }
    await student.waitForFunction((id) => curTask && curTask.id === id, source.id);
    if (source.type === 'choice') {
      await student.getByRole('button', { name: source.options[source.answer], exact: true }).click();
    } else if (source.id === 'demo_triangle') {
      await student.locator('#graph').waitFor();
      await drawTriangle(student);
      await shot(student, 'student-graph');
      await teacher.waitForFunction(() => document.getElementById('answered').textContent.includes('5/6'));
      await shot(teacher, 'teacher-live');
      await student.locator('#gsubmit').click();
    } else {
      // Other interactive types are covered over real WS in e2e_test.py.
      const payload = source.type === 'graph' ? { edges: source.example } :
        source.type === 'order' ? { order: ['A', 'B', 'C', 'D', 'E'] } : { array: source.expected };
      await student.evaluate(({ taskId, payload }) => ws.send(JSON.stringify({ type: 'answer', taskId, payload })), { taskId: source.id, payload });
    }
  }
  await teacher.locator('#resultsView').waitFor({ state: 'visible' });
  await student.locator('#done').waitFor({ state: 'visible' });
  await shot(teacher, 'teacher-results');
  await shot(student, 'student-review');
  await teacher.locator('#statsBtn').click();
  await teacher.locator('#statsModal').waitFor({ state: 'visible' });
  await teacher.waitForFunction(() => document.getElementById('statsMeta').textContent.includes('Sessions:'));
  await teacher.locator('#statsSessBody tr').first().waitFor();
  await shot(teacher, 'teacher-analytics');
  const answers = await desktop.newPage();
  answers.on('pageerror', (e) => errors.push(e.message));
  await answers.goto(base + '/answers');
  await answers.locator('#list .item').first().waitFor();
  assert.equal(await answers.locator('html').getAttribute('lang'), 'en');
  assert.equal(await teacher.locator('html').getAttribute('lang'), 'en');
  assert.equal(await student.locator('html').getAttribute('lang'), 'en');
  assert.deepEqual(errors, []);
  console.log('Browser checks passed; screenshots saved in docs/images/');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const peer of bots) peer.ws.close();
  if (browser) await browser.close();
});
