// Synthetic concurrent-room smoke benchmark. Run only on an isolated candidate server.
const WebSocket = require('ws');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const base = process.env.WORKSPACE_TEST_URL || 'http://127.0.0.1:8099';
const studentsPerRoom = Number(process.env.STUDENTS_PER_ROOM || 60);
const password = 'load-test-password-long';
function request(cookie, path, body) {
  return fetch(base + '/api/workspace' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie || '', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(data));
    return { data, cookie: r.headers.get('set-cookie')?.split(';')[0] };
  });
}
function connect(path, cookie) {
  return new Promise((ok, no) => {
    const ws = new WebSocket(base.replace('http', 'ws') + path, {
      headers: { Cookie: cookie || '' },
    });
    ws.messages = [];
    ws.waiters = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      const index = ws.waiters.findIndex((w) => w.type === m.type);
      if (index >= 0) ws.waiters.splice(index, 1)[0].resolve(m);
      else ws.messages.push(m);
    });
    ws.once('open', () => ok(ws));
    ws.once('error', no);
  });
}
function receive(ws, type) {
  const i = ws.messages.findIndex((m) => m.type === type);
  if (i >= 0) return Promise.resolve(ws.messages.splice(i, 1)[0]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout: ' + type)), 20000);
    ws.waiters.push({
      type,
      resolve: (m) => {
        clearTimeout(timer);
        resolve(m);
      },
    });
  });
}
(async () => {
  let all = [];
  const started = performance.now();
  try {
    const status = await request('', '/status');
    let owner;
    const email = process.env.OWNER_EMAIL || 'load-owner@example.org';
    if (!status.data.initialized)
      owner = await request('', '/setup', {
        key: process.env.BOOTSTRAP_KEY || 'LOCAL-TEST-ONLY',
        email,
        name: 'Load Owner',
        subject: 'Synthetic',
        password,
      });
    else
      owner = await request('', '/login', {
        email,
        password: process.env.OWNER_PASSWORD || password,
      });
    const setups = [];
    for (let n = 0; n < 2; n++) {
      const inv = await request(owner.cookie, '/admin/invite', {
        email: `load-${Date.now()}-${n}@example.org`,
        sections: ['algorithms'],
      });
      const teacher = await request('', '/activate', {
        token: inv.data.token,
        name: 'Load Teacher ' + n,
        subject: 'Algorithms',
        password,
      });
      const tasks = Array.from({ length: 3 }, (_, i) => ({
        id: 'q' + i,
        title: 'Load question ' + i,
        prompt: 'Choose A',
        type: 'choice',
        section: 'algorithms',
        options: ['A', 'B'],
        answer: 0,
        timeLimit: 30,
      }));
      const imported = await request(teacher.cookie, '/import', {
        title: 'Load room ' + n,
        section: 'algorithms',
        mode: 'once',
        tasks,
      });
      const rid = imported.data.room;
      await request(teacher.cookie, `/rooms/${rid}/settings`, {
        title: 'Load room ' + n,
        reveal: 'after',
        importId: imported.data.import_id,
      });
      const tw = await connect('/teacher?room=' + rid, teacher.cookie);
      all.push(tw);
      await receive(tw, 'state');
      const clients = await Promise.all(
        Array.from({ length: studentsPerRoom }, async (_, i) => {
          const ws = await connect('/?room=' + rid);
          all.push(ws);
          ws.send(
            JSON.stringify({ type: 'join', nick: 'Synthetic student ' + i, resumeProtocol: 1 })
          );
          const joined = await receive(ws, 'joined');
          return { ws, nick: joined.nick, resume: joined.resume };
        })
      );
      setups.push({ tw, clients, rid, cookie: teacher.cookie });
    }
    const latencies = [];
    await Promise.all(
      setups.map(async ({ tw, clients, rid }) => {
        tw.send(JSON.stringify({ type: 'start' }));
        for (let round = 0; round < 3; round++) {
          await Promise.all(
            clients.map(async (c) => {
              let msg = await receive(c.ws, 'task');
              while (msg.task.id === c.lastId) msg = await receive(c.ws, 'task');
              c.lastId = msg.task.id;
              assert.equal(msg.task.type, 'choice');
              const choice = msg.task.options.indexOf('A');
              const t = performance.now();
              c.ws.send(
                JSON.stringify({ type: 'answer', taskId: msg.task.id, payload: { choice } })
              );
              const answer = await receive(c.ws, 'answered');
              assert.equal(answer.feedbackHidden, true);
              latencies.push(performance.now() - t);
              await receive(c.ws, 'roundover');
            })
          );
          if (round === 0) {
            const c = clients[0];
            c.ws.close();
            const ws = await connect('/?room=' + rid);
            all.push(ws);
            ws.send(
              JSON.stringify({
                type: 'join',
                nick: c.nick,
                resume: c.resume,
                resumeProtocol: 1,
                auto: true,
              })
            );
            await receive(ws, 'joined');
            c.ws = ws;
          }
        }
        await Promise.all(
          clients.map(async (c) => {
            const end = await receive(c.ws, 'sessionend');
            assert.equal(end.review.length, 3);
            assert.equal(end.correct, 3);
          })
        );
      })
    );
    for (const s of setups) {
      const own = (await request(s.cookie, '/sessions')).data;
      assert.equal(own.length, 1);
      const rep = (await request(s.cookie, '/sessions/' + own[0].id)).data;
      assert.equal(rep.answers.length, studentsPerRoom * 3);
      assert.equal(rep.results.length, studentsPerRoom);
      assert.equal(rep.questions.length, 3);
      assert.ok(rep.answers.every((a) => a.answer_text === 'A'));
    }
    latencies.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        passed: true,
        rooms: 2,
        students: studentsPerRoom * 2,
        answers: latencies.length,
        answer_p99_ms: Math.round(latencies[Math.floor(latencies.length * 0.99)]),
        duration_s: ((performance.now() - started) / 1000).toFixed(1),
        isolation:
          'each teacher sees exactly one owned session; identical student names in separate rooms; answers retained after reconnect',
      })
    );
  } finally {
    for (const ws of all) ws.terminate();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
