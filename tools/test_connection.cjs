// Exercise the actual student connection code with deterministic network failures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const html = fs.readFileSync('frontend/student.html', 'utf8');
const source = html.slice(html.indexOf('      const proto ='), html.indexOf('      // Код входа из QR'));
function setup() {
  let now = 1000;
  let next = 0;
  const timers = new Map();
  const sockets = [];
  const events = {};
  const messages = [];
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
    open() { this.readyState = 1; this.onopen(); }
    message(m) { this.onmessage({ data: JSON.stringify(m) }); }
  }
  const context = vm.createContext({
    WebSocket: Socket, location: { protocol: 'https:', host: 'example.test' },
    Date: { now: () => now }, me: { nick: 'Student' },
    $: () => ({}), handle: (m) => messages.push(m),
    window: { addEventListener: (name, fn) => { events[name] = fn; } },
    document: { hidden: false, addEventListener: (name, fn) => { events[name] = fn; } },
    setTimeout: (fn, delay) => { timers.set(++next, { fn, delay }); return next; },
    setInterval: (fn, delay) => { timers.set(++next, { fn, delay, interval: true }); return next; },
    clearTimeout: (id) => timers.delete(id), clearInterval: (id) => timers.delete(id),
  });
  // Fixed jitter: reconnectDelay() becomes exactly 1000 ms.
  vm.runInContext('Math.random = () => 0.5;', context);
  vm.runInContext(source, context);
  vm.runInContext("lastJoin = { type: 'join', nick: 'Student', token: 'old' };", context);
  return { sockets, events, messages, context,
    advance: (ms) => { now += ms; },
    run: (delay) => {
      for (const [id, t] of [...timers]) {
        if (t.delay !== delay || !timers.has(id)) continue;
        if (!t.interval) timers.delete(id);
        t.fn();
      }
    },
  };
}
test('silent open socket is replaced; old events cannot corrupt new connection', () => {
  const x = setup(); const old = x.sockets[0]; old.open();
  x.advance(16000); x.run(4000); x.run(1000);
  assert.equal(x.sockets.length, 2);
  const fresh = x.sockets[1]; fresh.open();
  assert.equal(fresh.sent[0].recovery, 'heartbeat_timeout');
  assert.equal(fresh.sent[0].nick, 'Student');
  old.message({ type: 'task', stale: true }); old.onclose();
  x.run(1000);
  assert.equal(x.messages.length, 0);
  assert.equal(x.sockets.length, 2);
});
test('healthy pong keeps connection alive, including wake from a short suspension', () => {
  const x = setup(); const socket = x.sockets[0]; socket.open();
  for (let i = 0; i < 12; i++) {
    x.advance(4000); socket.message({ type: 'pong' }); x.run(4000);
  }
  x.events.visibilitychange(); socket.message({ type: 'pong' }); x.run(2500); x.run(1000);
  assert.equal(x.sockets.length, 1);
  assert.equal(x.messages.length, 0);
});
test('hung opening connection times out and retry creates only one socket', () => {
  const x = setup(); x.run(15000); x.run(1000);
  assert.equal(x.sockets.length, 2);
  vm.runInContext('connectWS(); connectWS();', x.context);
  assert.equal(x.sockets.length, 2);
});
test('resuming a suspended tab detects a stale connection immediately', () => {
  const x = setup(); x.sockets[0].open(); x.advance(60000);
  x.events.visibilitychange(); x.run(1000);
  assert.equal(x.sockets.length, 2);
});
test('normal closure restores join and completed games stop reconnecting', () => {
  const x = setup(); x.sockets[0].open(); x.sockets[0].close(); x.run(1000);
  x.sockets[1].open();
  assert.equal(x.sockets[1].sent[0].recovery, 'socket_closed');
  vm.runInContext('me.done = true;', x.context);
  x.sockets[1].close(); x.run(1000);
  assert.equal(x.sockets.length, 2);
});
test('waking with a socket that looks open but is dead reconnects within the probe window', () => {
  const x = setup(); const socket = x.sockets[0]; socket.open();
  x.advance(3000); x.events.visibilitychange();
  assert.equal(socket.sent.at(-1).type, 'ping');
  x.advance(2500); x.run(2500); x.run(1000);
  assert.equal(x.sockets.length, 2);
  x.sockets[1].open();
  assert.equal(x.sockets[1].sent[0].recovery, 'resume_probe');
});
test('unacknowledged answer triggers a probe and a reconnect instead of hanging', () => {
  const x = setup(); const socket = x.sockets[0]; socket.open();
  vm.runInContext("submitAnswer('t1', { choice: 0 });", x.context);
  assert.deepEqual(socket.sent.at(-1), { type: 'answer', taskId: 't1', payload: { choice: 0 } });
  x.advance(5000); x.run(5000);
  assert.equal(socket.sent.at(-1).type, 'ping');
  x.advance(2500); x.run(2500); x.run(1000);
  assert.equal(x.sockets.length, 2);
  x.sockets[1].open();
  assert.equal(x.sockets[1].sent[0].recovery, 'answer_timeout');
  // The answer stays queued until the server re-sends the task after rejoin.
  assert.equal(vm.runInContext('pendingAnswer && pendingAnswer.taskId', x.context), 't1');
});
test('acknowledged answer with a live connection does not reconnect', () => {
  const x = setup(); const socket = x.sockets[0]; socket.open();
  vm.runInContext("submitAnswer('t1', { choice: 0 });", x.context);
  x.advance(5000); x.run(5000); socket.message({ type: 'pong' });
  x.run(2500); x.run(1000);
  assert.equal(x.sockets.length, 1);
  vm.runInContext('settleAnswer();', x.context);
  assert.equal(vm.runInContext('pendingAnswer', x.context), null);
});
test('answering while offline queues the answer without throwing', () => {
  const x = setup(); x.sockets[0].open(); x.sockets[0].close();
  vm.runInContext("submitAnswer('t2', { blanks: ['x'] });", x.context);
  assert.equal(vm.runInContext('pendingAnswer.taskId', x.context), 't2');
  assert.equal(x.sockets[0].sent.filter((m) => m.type === 'answer').length, 0);
});
