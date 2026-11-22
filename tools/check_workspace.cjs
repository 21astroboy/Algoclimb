// Run against tools/demo_server.py. Uses an isolated public bank and synthetic names.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ channel: process.env.SCREENSHOT_BROWSER || undefined });
  try {
    const context = await browser.newContext();
    const teacher = await context.newPage();
    const student = await (await browser.newContext()).newPage();
    const portal = await context.newPage();
    const errors = [];
    for (const page of [teacher, student, portal]) page.on('pageerror', (e) => errors.push(e.message));
    const base = 'http://127.0.0.1:8098';
    await teacher.goto(base + '/teacher');
    await teacher.locator('#keyInput').fill('LOCAL-DEMO-ONLY');
    await teacher.locator('#keyForm button').click();
    await teacher.locator('.catrow').first().waitFor();
    // Section navigation must not offer questions from a different subject.
    await teacher.locator('[data-f="section"][data-v="db"]').click();
    assert.equal(await teacher.locator('.catrow').count(), 0);
    assert.ok((await teacher.locator('#catList').textContent()).includes('No question sets'));
    await teacher.locator('[data-f="section"][data-v="algorithms"]').click();
    assert.ok(await teacher.locator('.catrow').count() > 0);
    await student.goto(base);
    await student.locator('#nick').fill('Guest tester');
    await student.locator('#joinBtn').click();
    await student.locator('#lobby').waitFor({ state: 'visible' });
    const task = { id: 'guest-stack', type: 'choice', section: 'oop', title: 'Guest stack', prompt: 'Which rule does a stack follow?', options: ['LIFO', 'FIFO'], answer: 0 };
    await teacher.locator('#uploadBankFile').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify([{ ...task, answer: 99 }])) });
    await teacher.locator('#importError').filter({ hasText: 'Question 1' }).waitFor();
    assert.equal(await teacher.locator('#catalogControls').isVisible(), true);
    await teacher.locator('#uploadBankFile').setInputFiles({ name: 'workshop.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify([task])) });
    await teacher.locator('#uploadBankPanel').waitFor({ state: 'visible' });
    await teacher.locator('#importTitle').fill('Guest workshop UI test');
    assert.equal(await teacher.locator('#catalogControls').isVisible(), false);
    await teacher.locator('#startBtn').click();
    await student.getByRole('button', { name: 'LIFO', exact: true }).click();
    await teacher.locator('#resultsView').waitFor({ state: 'visible' });
    await student.locator('#done').waitFor({ state: 'visible' });
    await portal.goto(base + '/developers');
    await portal.getByLabel('Teacher key').fill('LOCAL-DEMO-ONLY');
    await portal.getByRole('button', { name: 'Create API key', exact: true }).click();
    await portal.locator('#created').waitFor({ state: 'visible' });
    assert.ok((await portal.locator('#token').textContent()).startsWith('ac_dev_'));
    await portal.getByRole('button', { name: 'Load sessions', exact: true }).click();
    await portal.locator('#rows tr').filter({ hasText: 'Guest workshop UI test' }).waitFor();
    assert.ok((await portal.locator('#rows').textContent()).includes('Guest tester'));
    await portal.locator('#rows tr').filter({ hasText: 'Guest workshop UI test' }).getByRole('button', { name: 'results', exact: true }).click();
    await portal.locator('#details').waitFor({ state: 'visible' });
    assert.ok((await portal.locator('#details').textContent()).includes('Guest tester'));
    await portal.getByRole('button', { name: 'Revoke key', exact: true }).click();
    await portal.locator('#keyStatus').filter({ hasText: 'Key revoked.' }).waitFor();
    assert.equal(await portal.locator('#load').isDisabled(), true);
    assert.deepEqual(errors, []);
    console.log('Subject navigation, import validation, guest session, API-key portal and saved results passed');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
