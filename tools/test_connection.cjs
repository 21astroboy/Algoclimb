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
  x.advance(16000); x.run(5000); x.run(1000);
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
    x.advance(5000); socket.message({ type: 'pong' }); x.run(5000);
  }
  x.events.visibilitychange(); x.run(1000);
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
