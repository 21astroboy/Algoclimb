/*
 * AlgoClimb — локальный сервер для интерактивных лекций (синхронная модель).
 * Весь класс отвечает на один и тот же вопрос; раунд закрывается, когда все
 * ответили ИЛИ истёк таймер. Очки — за скорость и сложность вопроса.
 * Зависит только от: ws, qrcode. Хранилище — встроенный node:sqlite (Node 22+), иначе JSONL.
 *
 * Запуск:  npm install  &&  npm start
 * Преподаватель:  http://<ip-ноута>:3000/teacher
 * Студент:        http://<ip-ноута>:3000/
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const db = require('./db');
const { TASKS, publicTask, activeTasks, answerText, answerEdges, buildCustomTask, graphTemplateList, paramizeTask } = require('./tasks');
// Объяснения к задачам (показываются студентам после окончания игры). Не обязательны.
const EXPLAIN = (() => { try { return require('./explanations'); } catch { return {}; } })();
const { buildXlsx } = require('./lib/xlsx-lite');   // генератор .xlsx без зависимостей

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
// Быстрые переключатели secure-режима без правки JSON (удобно для запуска/тестов).
if (process.env.QR_ROTATION === '1') config.qrRotation.enabled = true;
if (process.env.QR_ROTATION === '0') config.qrRotation.enabled = false;
if (process.env.QR_INTERVAL) config.qrRotation.intervalSec = Number(process.env.QR_INTERVAL) || config.qrRotation.intervalSec;
// Режим отладки: удобно тестировать оба экрана (студент + преподаватель) с одной машины.
config.debug = config.debug || { enabled: false };
if (process.env.DEBUG === '1') config.debug.enabled = true;
if (process.env.DEBUG === '0') config.debug.enabled = false;
const PUBLIC = path.join(__dirname, 'public');

/* ---------- пользовательские задачи из конструктора (data/custom-tasks.json) ---------- */
const CUSTOM_FILE = path.join(__dirname, 'data', 'custom-tasks.json');
let customSpecs = [];                                // «плоские» спецификации (без функций)
function loadCustomTasks() {
  try {
    customSpecs = JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8'));
    if (!Array.isArray(customSpecs)) customSpecs = [];
  } catch { customSpecs = []; }
  for (const spec of customSpecs) {
    const t = buildCustomTask(spec);
    if (t && !TASKS.some(x => x.id === t.id)) TASKS.push(t);
  }
}
function saveCustomTasks() {
  try {
    fs.mkdirSync(path.dirname(CUSTOM_FILE), { recursive: true });
    fs.writeFileSync(CUSTOM_FILE, JSON.stringify(customSpecs, null, 2));
  } catch (e) { console.error('Не удалось сохранить пользовательские задачи:', e.message); }
}
loadCustomTasks();

let POOL = activeTasks(config.activeTasks);   // банк, из которого набираем задачи на сессию
let BY_ID = new Map(TASKS.map(t => [t.id, t]));   // весь банк по id (для ручного выбора)
function rebuildBank() { POOL = activeTasks(config.activeTasks); BY_ID = new Map(TASKS.map(t => [t.id, t])); }

// Каталог всего банка для конструктора сессии (без ответов/проверок).
function catalogData() {
  return TASKS.map(t => ({
    id: t.id, title: t.title, prompt: t.prompt,
    topic: t.topic, type: t.type, level: t.level || 1, custom: !!t.custom
  }));
}

const PORT = Number(process.env.PORT) || config.port;
const HOST_IP = (process.env.HOST_IP || '').trim();

/* ---------- ключ преподавателя (защита ответов и управления) ---------- */
function genKey() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
const TEACHER_KEY = (process.env.TEACHER_KEY || config.teacherKey || '').trim() || genKey();

const TIME = config.timeLimits || { choice: 10, graph: 25 };
const SCORE = config.scoring || { base: 100, minFraction: 0.4 };
const REVEAL_MS = config.revealMs || 1800;
const AC = config.antiCheat || { fastMs: 1500, suspectThreshold: 4 };   // анти-ИИ телеметрия

// Короткое время — выбор/пропуски; длинное — интерактив (граф, обход, сортировка).
function timeLimitFor(task) {
  const quick = (task.type === 'choice' || task.type === 'blank');
  return (quick ? TIME.choice : TIME.graph) * 1000;
}

/* ---------- выбор набора задач на сессию (демо-режим) ---------- */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function selectTasks() {
  const demo = config.demo || {};
  if (!demo.enabled) return POOL.slice();
  const n = Math.max(1, demo.count || 5);
  if (POOL.length <= n) return shuffle(POOL);

  let picked = [];
  if (demo.onePerType) {
    const types = [...new Set(POOL.map(t => t.type))];
    types.forEach(tp => {
      const pool = shuffle(POOL.filter(t => t.type === tp));
      if (pool.length) picked.push(pool[0]);
    });
  }
  const rest = shuffle(POOL.filter(t => !picked.includes(t)));
  for (const t of rest) { if (picked.length >= n) break; picked.push(t); }
  return shuffle(picked).slice(0, n);
}

/* ---------- QR-код ссылки для студентов ---------- */
let qrSvg = null, joinUrl = null;
function buildQr() {
  const ip = HOST_IP || localIps()[0] || 'localhost';
  const base = `http://${ip}:${PORT}/`;
  // В secure-режиме код входа вшит прямо в QR (?t=КОД): картинка меняется каждое окно,
  // студент сканирует — код подставляется сам, а старый скриншот протухает.
  joinUrl = config.qrRotation.enabled ? `${base}?t=${currentTokenVal()}` : base;
  try {
    const QRCode = require('qrcode');
    QRCode.toString(joinUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }, (e, svg) => {
      if (!e) { qrSvg = svg; broadcastTeacher(); }
    });
  } catch (e) { console.warn('[qr] qrcode не установлен — на экране будет только ссылка.'); }
}

/* ---------- IP allowlist (по умолчанию выключен) ---------- */
function ipToInt(ip) {
  const p = ip.replace('::ffff:', '').split('.').map(Number);
  if (p.length !== 4 || p.some(isNaN)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function inCidr(ip, cidr) {
  const [net, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  const a = ipToInt(ip), b = ipToInt(net);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}
function ipAllowed(ip) {
  if (!config.ipAllowlist.enabled) return true;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  return config.ipAllowlist.cidrs.some(c => inCidr(ip, c));
}
const remoteIp = req => (req.socket.remoteAddress || '').toString();
// Локальная петля (та же машина). В debug-режиме такой вход минует всю защиту.
function isLoopback(ip) {
  const a = (ip || '').replace('::ffff:', '');
  return a === '127.0.0.1' || a === '::1' || a === 'localhost' || a.startsWith('127.');
}
function debugLocal(ip) { return config.debug && config.debug.enabled && isLoopback(ip); }

/* ---------- QR-токен: TOTP-style, ротация по умолчанию выключена ----------
   Код входа детерминированно считается из времени (HMAC по номеру окна),
   поэтому сервер ничего не хранит и не рассылает «правильный» код.
   На входе принимаем текущее окно и ещё graceWindows предыдущих — это убирает
   ложные отказы, когда код сменился между загрузкой страницы и нажатием «Войти». */
const TOTP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 32 символа, без похожих 0/O/1/I
const TOTP_SECRET = ((config.qrRotation && config.qrRotation.secret) || '').trim()
  || crypto.randomBytes(16).toString('hex');
function intervalMs() { return Math.max(1, config.qrRotation.intervalSec || 8) * 1000; }
function tokenWindow() { return Math.floor(Date.now() / intervalMs()); }
function totpFor(win) {
  const h = crypto.createHmac('sha256', TOTP_SECRET).update(String(win)).digest();
  let s = '';
  for (let i = 0; i < 6; i++) s += TOTP_ALPHABET[h[i] & 31];   // 32 символа → 5 бит
  return s;
}
function currentTokenVal() { return totpFor(tokenWindow()); }
function tokenOk(tok) {
  if (!config.qrRotation.enabled) return true;
  if (!tok) return false;
  const t = String(tok).trim().toUpperCase();
  const w = tokenWindow();
  const grace = (config.qrRotation.graceWindows != null) ? config.qrRotation.graceWindows : 1;
  for (let d = 0; d <= grace; d++) if (t === totpFor(w - d)) return true;
  return false;
}
if (config.qrRotation.enabled) {
  setInterval(() => { buildQr(); broadcastTeacher(); }, intervalMs());   // перерисовать QR с новым кодом
}

/* ---------- Одноразовый код входа (nonce) ----------
   Страница студента получает свежий nonce при загрузке (GET /api/nonce).
   Вход требует валидный токен И не использованный nonce — один и тот же
   запрос на вход нельзя повторить/расшарить. Активно только в secure-режиме. */
const nonces = new Map();                 // nonce -> срок годности (epoch ms)
const NONCE_TTL = 120000;                 // 2 минуты на ввод ника и вход
function issueNonce() {
  const n = crypto.randomBytes(12).toString('base64url');
  nonces.set(n, Date.now() + NONCE_TTL);
  return n;
}
function consumeNonce(n) {
  if (!n) return false;
  const exp = nonces.get(n);
  if (!exp) return false;
  nonces.delete(n);                       // одноразовый: гасим при первом использовании
  return exp > Date.now();
}
setInterval(() => { const now = Date.now(); for (const [n, e] of nonces) if (e <= now) nonces.delete(n); }, 60000);

/* ---------- состояние сессии ---------- */
let currentStream = config.stream;   // номер потока; можно менять с экрана преподавателя (только в лобби)
// Запись в БД создаём не в лобби, а при старте — и только если сессия НЕ тестовая.
// test=true → результаты никуда не пишутся (id локальный, db.* не вызываются).
let session = { id: null, status: 'lobby', test: false };
const students = new Map();   // ws -> student
const byNick = new Map();     // nick -> student

let order = [];               // задачи, выбранные на эту сессию
let round = -1;               // текущий раунд (индекс в order)
let roundDeadline = 0;        // дедлайн раунда, epoch ms
let roundTimer = null;
let roundPerm = null;         // перестановка вариантов текущего choice-вопроса
let roundAnswered = new Set();// ники, ответившие в этом раунде
let intermission = false;     // пауза между вопросами (показ результата)
let paused = false;           // пауза раунда преподавателем
let pauseRemain = 0;          // сколько мс оставалось на раунд в момент паузы

function makeStudent(nick, icon, ip) {
  return { nick, icon, ip, joinedAt: Date.now(), score: 0, correct: 0, streak: 0, bestStreak: 0, tabLeaves: 0, fastAnswers: 0, kicked: false, answers: [] };
}

/* ---------- рассылки ---------- */
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
const teachers = new Set();

function isConnected(nick) {
  for (const s of students.values()) if (s.nick === nick) return true;
  return false;
}
function connectedNicks() {
  const set = new Set();
  for (const s of students.values()) if (!s.kicked) set.add(s.nick);
  return set;
}
function rosterArr() {
  return [...byNick.values()].filter(s => !s.kicked)
    .map(s => ({ nick: s.nick, icon: s.icon }));
}
function leaderboard() {
  const rows = [...byNick.values()].filter(s => !s.kicked).map(s => ({
    nick: s.nick, icon: s.icon, score: s.score, correct: s.correct,
    tabLeaves: s.tabLeaves, fastAnswers: s.fastAnswers || 0, connected: isConnected(s.nick),
    answeredThisRound: roundAnswered.has(s.nick),
    answers: s.answers.map(a => a ? { correct: a.correct, answered: a.answered } : null)
  }));
  rows.sort((a, b) => (b.score - a.score) || (b.correct - a.correct));
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}
// Полный ключ ответов (весь банк) — только для экрана преподавателя/страницы /answers.
function answerKeyData() {
  return POOL.map(t => ({
    id: t.id, title: t.title, prompt: t.prompt, topic: t.topic,
    type: t.type, level: t.level || 1, answer: answerText(t)
  }));
}

// Подробный разбор по каждому вопросу: что ответил каждый студент + время ответа.
// Только для экрана преподавателя.
function sessionDetails() {
  return order.map((task, ri) => ({
    index: ri, id: task.id, title: task.title, prompt: task.prompt,
    type: task.type, correctAnswer: answerText(task),
    nodes: (task.type === 'graph' || task.type === 'order') ? (task.nodes || []) : null,   // вершины для рисунка
    answerGraph: (task.type === 'graph' || task.type === 'order') ? answerEdges(task) : null, // граф для рисунка
    responses: [...byNick.values()].filter(s => !s.kicked).map(s => {
      const a = s.answers[ri];
      return {
        nick: s.nick, icon: s.icon,
        answered: !!(a && a.answered),
        correct: !!(a && a.correct),
        ms: (a && a.answered) ? a.ms : null,
        points: a ? a.points : 0,
        answer: (a && a.answered) ? (a.ansText || '') : null
      };
    })
  }));
}

function broadcastTeacher() {
  const task = round >= 0 ? order[round] : null;
  const payload = {
    type: 'state',
    session: { status: session.status, stream: currentStream, total: order.length },
    test: !!session.test,
    round, roundTotal: order.length,
    currentType: task ? task.type : null,
    currentId: task ? task.id : null,
    currentTitle: task ? task.title : null,
    currentAnswer: task ? answerText(task) : null,   // правильный ответ — виден только преподавателю
    deadline: session.status === 'running' && !intermission && !paused ? roundDeadline : 0,
    limit: task ? timeLimitFor(task) : 0,
    serverTime: Date.now(),
    answeredCount: roundAnswered.size,
    activeCount: connectedNicks().size,
    intermission, paused,
    token: config.qrRotation.enabled ? currentTokenVal() : null,
    qrSvg, joinUrl,
    roster: rosterArr(),
    leaderboard: leaderboard(),
    details: order.length ? sessionDetails() : []   // разбор по вопросам (только учителю)
  };
  teachers.forEach(ws => send(ws, payload));
}

/* отправить текущий вопрос одному студенту (с учётом перестановки вариантов) */
function sendCurrentTask(s, ws) {
  if (round < 0 || !order[round]) return;
  const task = order[round];
  const pub = publicTask(task);
  if (task.type === 'choice' && roundPerm) {
    pub.options = roundPerm.map(i => task.options[i]);
  }
  send(ws, {
    type: 'task', index: round, total: order.length, task: pub,
    deadline: roundDeadline, serverTime: Date.now(), limit: timeLimitFor(task)
  });
  // если уже отвечал в этом раунде — сразу залочить и показать результат
  const a = s.answers[round];
  if (a && a.answered) send(ws, { type: 'answered', correct: a.correct, points: a.points, picked: a.picked });
  if (paused) send(ws, { type: 'paused' });   // переподключился во время паузы
}

/* ---------- игровой цикл ---------- */
function beginRound(idx) {
  round = idx;
  const task = order[idx];
  roundAnswered = new Set();
  roundPerm = task.type === 'choice' ? shuffle(task.options.map((_, i) => i)) : null;
  roundDeadline = Date.now() + timeLimitFor(task);
  paused = false; pauseRemain = 0;

  students.forEach((s, ws) => { if (!s.kicked) sendCurrentTask(s, ws); });
  clearTimeout(roundTimer);
  roundTimer = setTimeout(() => endRound('timeout'), timeLimitFor(task) + 400);
  broadcastTeacher();
}

function endRound(reason) {
  if (round < 0 || intermission) return;
  clearTimeout(roundTimer); roundTimer = null;
  // тем, кто не ответил, фиксируем «нет ответа» для статистики
  for (const s of byNick.values()) {
    if (s.kicked) continue;
    const a = s.answers[round];
    if (!a || !a.answered) { s.answers[round] = { taskId: order[round].id, correct: false, points: 0, answered: false }; s.streak = 0; }
  }
  intermission = true;
  students.forEach((s, ws) => {
    if (s.kicked) return;
    const a = s.answers[round];
    send(ws, { type: 'roundover', correct: !!(a && a.correct), answered: !!(a && a.answered) });
  });
  broadcastTeacher();
  setTimeout(() => {
    intermission = false;
    if (round + 1 >= order.length) finishGame();
    else beginRound(round + 1);
  }, REVEAL_MS);
}

function maybeEndRound() {
  if (paused) return;   // на паузе раунд не закрываем автоматически
  const nicks = [...connectedNicks()];
  if (nicks.length > 0 && nicks.every(n => roundAnswered.has(n))) endRound('all');
}

/* ---------- управление раундом преподавателем ---------- */
function pauseRound() {
  if (session.status !== 'running' || round < 0 || intermission || paused) return;
  paused = true;
  pauseRemain = Math.max(0, roundDeadline - Date.now());
  clearTimeout(roundTimer); roundTimer = null;
  students.forEach((s, ws) => { if (!s.kicked) send(ws, { type: 'paused' }); });
  broadcastTeacher();
}
function resumeRound() {
  if (session.status !== 'running' || round < 0 || intermission || !paused) return;
  paused = false;
  roundDeadline = Date.now() + pauseRemain;
  clearTimeout(roundTimer);
  roundTimer = setTimeout(() => endRound('timeout'), pauseRemain + 400);
  students.forEach((s, ws) => {
    if (s.kicked) return;
    send(ws, { type: 'resumed', deadline: roundDeadline, serverTime: Date.now(), limit: timeLimitFor(order[round]) });
  });
  broadcastTeacher();
}
function skipRound() {
  if (session.status !== 'running' || round < 0 || intermission) return;
  paused = false;
  clearTimeout(roundTimer); roundTimer = null;
  endRound('skip');
}
function addRoundTime(ms) {
  if (session.status !== 'running' || round < 0 || intermission) return;
  ms = Math.max(0, Math.min(120000, ms | 0));
  if (paused) { pauseRemain += ms; broadcastTeacher(); return; }
  roundDeadline += ms;
  clearTimeout(roundTimer);
  roundTimer = setTimeout(() => endRound('timeout'), Math.max(0, roundDeadline - Date.now()) + 400);
  students.forEach((s, ws) => {
    if (s.kicked) return;
    send(ws, { type: 'addtime', deadline: roundDeadline, serverTime: Date.now() });
  });
  broadcastTeacher();
}

function finishGame() {
  session.status = 'finished';
  const ranked = leaderboard();
  if (!session.test) {
    db.setSessionStatus(session.id, 'finished');
    ranked.forEach((r, i) => db.recordResult(session.id, r.nick, 0, 1, r.score, i + 1));
  }
  students.forEach((s, ws) => {
    if (s.kicked) return;
    const place = ranked.findIndex(r => r.nick === s.nick) + 1;
    // персональный разбор с объяснениями — отправляем только после завершения игры
    const review = order.map((task, ri) => {
      const a = s.answers[ri];
      return {
        title: task.title, prompt: task.prompt, type: task.type,
        answered: !!(a && a.answered), correct: !!(a && a.correct),
        yourAnswer: (a && a.answered) ? (a.ansText || '') : null,
        correctAnswer: answerText(task),
        explain: EXPLAIN[task.id] || ''
      };
    });
    send(ws, { type: 'sessionend', place, score: s.score, correct: s.correct,
      total: order.length, bestStreak: s.bestStreak || 0, review });
  });
  broadcastTeacher();
}

/* ---------- HTTP статика ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' };
// HTML-лаунчер режима отладки. showKey=true — показываем ключ преподавателя
// (только когда запрос пришёл с этой же машины и debug включён).
function debugPage(showKey) {
  const on = config.debug && config.debug.enabled;
  const keyBlock = (on && showKey)
    ? `<div class="key"><span class="lab">Ключ преподавателя</span><code id="k">${TEACHER_KEY}</code>
         <button onclick="navigator.clipboard&&navigator.clipboard.writeText(document.getElementById('k').textContent)">копировать</button></div>`
    : `<p class="muted">Ключ преподавателя показывается только при включённом debug и заходе с этой машины. Его печатает терминал сервера.</p>`;
  const offWarn = on ? '' :
    `<div class="warn">Режим отладки <b>выключен</b>. Запустите <code>DEBUG=1 node server.js</code> (или <code>"debug": {"enabled": true}</code> в config.json), чтобы заходить студентом с localhost без кода.</div>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>AlgoClimb — отладка</title>
<style>
  :root{--bg:#08111f;--panel:#102544;--panel2:#0c1c34;--line:#1d3a63;--accent:#ffd23f;--blue:#5aa9ff;--text:#e8eef7;--muted:#8195b4}
  *{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
    background:radial-gradient(1200px 700px at 70% -10%,#14385f,#0c1d36 45%,#08111f);color:var(--text);min-height:100vh}
  .wrap{max-width:760px;margin:0 auto;padding:26px}
  .logo{font-weight:800;font-size:24px;margin-bottom:2px}.logo b{color:var(--accent)}
  .tag{font-size:13px;color:var(--muted);margin-bottom:20px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  a.card{display:block;text-decoration:none;color:var(--text);background:linear-gradient(180deg,var(--panel),var(--panel2));
    border:1px solid var(--line);border-radius:14px;padding:18px 18px 16px;transition:.15s}
  a.card:hover{border-color:var(--accent);transform:translateY(-2px)}
  .card .h{font-weight:800;font-size:17px;margin-bottom:4px}
  .card .d{font-size:13px;color:var(--muted);line-height:1.4}
  .card.wide{grid-column:1/-1}
  .key{margin:20px 0 6px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:#0c1c34;border:1px solid var(--line);border-radius:12px;padding:12px 14px}
  .key .lab{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:800}
  .key code{font-size:20px;letter-spacing:2px;color:var(--accent);font-weight:800}
  .key button{margin-left:auto;background:var(--accent);color:#10243f;border:none;border-radius:8px;padding:7px 12px;font-weight:800;cursor:pointer}
  .muted{color:var(--muted);font-size:13px}
  .warn{background:#3a2a16;border:1px solid #6b4b2b;border-radius:10px;padding:12px 14px;color:#ffd9a0;font-size:13px;margin:16px 0}
  .hint{margin-top:18px;font-size:13px;color:var(--muted);line-height:1.5}
  code{background:#0a1830;border:1px solid var(--line);border-radius:6px;padding:1px 6px;color:#bfe0ff}
</style></head><body><div class="wrap">
  <div class="logo">Algo<b>Climb</b> · отладка</div>
  <div class="tag">Открывай экраны на этой машине по разным адресам. Ссылки открываются в новой вкладке.</div>
  ${offWarn}
  <div class="grid">
    <a class="card" href="/teacher" target="_blank"><div class="h">🎛 Преподаватель</div><div class="d">Управление игрой, старт, аналитика, ключ ответов. Вход по ключу.</div></a>
    <a class="card" href="/" target="_blank"><div class="h">🧑‍🎓 Студент</div><div class="d">Экран игрока. В debug заходит с localhost без кода. Открой в неск. вкладках — несколько игроков.</div></a>
    <a class="card wide" href="/answers" target="_blank"><div class="h">🔑 Ключ ответов</div><div class="d">Правильные ответы по текущему вопросу и всему банку (для преподавателя).</div></a>
  </div>
  ${keyBlock}
  <div class="hint">Совет: расположи вкладки «Преподаватель» и «Студент» рядом (или в двух окнах). Запусти игру у преподавателя — студенческие вкладки пойдут по горе синхронно.</div>
</div></body></html>`;
}

const server = http.createServer((req, res) => {
  if (config.ipAllowlist.enabled && !ipAllowed(remoteIp(req)) && !debugLocal(remoteIp(req))) {
    res.writeHead(403); return res.end('Доступ только из сети вуза');
  }
  let url = req.url.split('?')[0];

  // Лаунчер режима отладки: ссылки на оба экрана + ключ (ключ — только при debug+localhost).
  if (url === '/debug') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(debugPage(debugLocal(remoteIp(req))));
  }

  // Свежий одноразовый код входа для страницы студента (IP-allowlist уже проверен выше).
  if (url === '/api/nonce') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ nonce: issueNonce(), serverTime: Date.now() }));
  }

  // Экспорт аналитики в Excel — только по ключу преподавателя (как и весь его интерфейс).
  if (url === '/export/analytics.xlsx') {
    const qs = new URL(req.url, 'http://x').searchParams;
    const key = (qs.get('key') || '').trim();
    if (key !== TEACHER_KEY) { res.writeHead(403); return res.end('Нужен ключ преподавателя'); }
    try {
      const buf = buildXlsx(analyticsSheets(qs.get('stream')));
      const fname = `algoclimb-аналитика-${new Date().toISOString().slice(0, 10)}.xlsx`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
        'Content-Length': buf.length
      });
      return res.end(buf);
    } catch (e) { res.writeHead(500); return res.end('Ошибка экспорта: ' + (e.message || e)); }
  }

  if (url === '/') url = '/student.html';
  if (url === '/teacher') url = '/teacher.html';
  if (url === '/answers') url = '/answers.html';
  const file = path.join(PUBLIC, path.normalize(url).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const ip = remoteIp(req).replace('::ffff:', '');
  const params = new URL(req.url, 'http://x').searchParams;
  const role = params.get('role');

  if (role === 'teacher') {
    // Доступ к экрану учителя/ключу ответов/управлению — только по правильному ключу.
    const key = (params.get('key') || '').trim();
    if (key !== TEACHER_KEY) {
      send(ws, { type: 'rejected', reason: 'Неверный ключ преподавателя.' });
      return ws.close();
    }
    teachers.add(ws);
    send(ws, { type: 'answerkey', items: answerKeyData() });  // ключ ответов (весь банк)
    send(ws, { type: 'catalog', items: catalogData() });      // каталог банка для конструктора сессии
    send(ws, { type: 'taskTemplates', graph: graphTemplateList() }); // шаблоны для конструктора задач
    broadcastTeacher();
    ws.on('close', () => teachers.delete(ws));
    ws.on('message', raw => { try { handleTeacher(ws, JSON.parse(raw)); } catch {} });
    return;
  }

  if (config.ipAllowlist.enabled && !ipAllowed(ip) && !debugLocal(ip)) {
    send(ws, { type: 'rejected', reason: 'Подключение разрешено только из сети вуза.' });
    return ws.close();
  }
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    handleStudent(ws, msg, ip);
  });
  ws.on('close', () => {
    if (students.has(ws)) students.delete(ws); // ник остаётся в byNick — можно переподключиться
    broadcastTeacher();
  });
});

function handleStudent(ws, msg, ip) {
  if (msg.type === 'join') {
    const nick = (msg.nick || '').trim().slice(0, 24);
    if (!nick) return send(ws, { type: 'rejected', reason: 'Пустой ник.' });
    const dbg = debugLocal(ip);   // debug + localhost — минуем защиту входа
    if (!dbg && !tokenOk(msg.token)) return send(ws, { type: 'rejected', reason: 'Неверный или устаревший код. Отсканируйте свежий QR.' });
    // Одноразовый nonce — только в secure-режиме; гасим его лишь после успешной проверки кода.
    if (!dbg && config.qrRotation.enabled && !consumeNonce(msg.nonce))
      return send(ws, { type: 'rejected', reason: 'Сессия входа устарела. Обновите страницу и войдите снова.' });

    let s = byNick.get(nick);
    if (s) {
      if (s.kicked) return send(ws, { type: 'rejected', reason: 'Вас удалили из сессии.' });
      students.set(ws, s);                 // переподключение
    } else {
      if (session.status !== 'lobby') return send(ws, { type: 'rejected', reason: 'Сессия уже началась.' });
      s = makeStudent(nick, msg.icon || '👾', ip);
      byNick.set(nick, s); students.set(ws, s);
      // Посещаемость пишем на старте игры (когда известно, тестовая сессия или нет).
    }
    send(ws, { type: 'joined', nick: s.nick, icon: s.icon, status: session.status });
    if (session.status === 'running' && !intermission) sendCurrentTask(s, ws);
    broadcastTeacher();
    return;
  }

  const s = students.get(ws);
  if (!s || s.kicked) return;

  if (msg.type === 'answer') {
    if (session.status !== 'running' || round < 0 || intermission) return;
    const task = order[round];
    if (!task || task.id !== msg.taskId) return;
    if (roundAnswered.has(s.nick)) return;            // одна попытка на раунд
    roundAnswered.add(s.nick);

    let payload = msg.payload || {};
    let picked = (typeof payload.choice === 'number') ? payload.choice : null;
    if (task.type === 'choice' && roundPerm && picked !== null) {
      payload = { choice: roundPerm[picked] };         // вернуть исходный индекс
    }
    const correct = !!task.check(payload);
    const now = Date.now();
    const limit = timeLimitFor(task);
    const timeLeftFrac = Math.max(0, Math.min(1, (roundDeadline - now) / limit));
    let points = 0, basePoints = 0, speedBonus = 0, streakBonus = 0;
    if (correct) {
      s.correct++;
      s.streak = (s.streak || 0) + 1;
      if (s.streak > s.bestStreak) s.bestStreak = s.streak;
      const lvl = task.level || 1;
      basePoints = Math.round(SCORE.base * lvl * SCORE.minFraction);                       // гарантированная часть
      speedBonus = Math.round(SCORE.base * lvl * (1 - SCORE.minFraction) * timeLeftFrac);   // вклад скорости
      const step = SCORE.streakStep != null ? SCORE.streakStep : 25;
      const cap = SCORE.streakMax != null ? SCORE.streakMax : 100;
      streakBonus = Math.min(cap, Math.max(0, s.streak - 1) * step);                        // бонус за серию (со 2-го подряд)
      points = basePoints + speedBonus + streakBonus;
      s.score += points;
    } else {
      s.streak = 0;   // ошибка сбрасывает серию
    }
    // человекочитаемый ответ студента — для разбора на экране преподавателя
    let ansText = '';
    if (task.type === 'choice' && picked !== null) ansText = task.options[payload.choice];
    else if (task.type === 'graph') ansText = (msg.payload.edges || []).map(e => e[0] + '–' + e[1]).join(', ') || '(пусто)';
    else if (task.type === 'order') ansText = (msg.payload.order || []).join(' → ') || '(пусто)';
    else if (task.type === 'sort') ansText = '[' + ((msg.payload.array || []).join(', ')) + ']';
    else if (task.type === 'blank') ansText = (msg.payload.blanks || []).map(v => v === '' || v == null ? '∅' : v).join(' | ') || '(пусто)';
    const ansMs = now - (roundDeadline - limit);
    s.answers[round] = { taskId: task.id, correct, points, answered: true, picked, ansText, ms: ansMs };
    if (!session.test) db.recordAnswer(session.id, s.nick, task.id, correct, ansMs);

    // Анти-ИИ: аномально быстрый верный ответ — вероятно, отвечал не человек.
    if (correct && ansMs >= 0 && ansMs < (AC.fastMs || 1500)) {
      s.fastAnswers = (s.fastAnswers || 0) + 1;
      if (!session.test) db.recordEvent(session.id, s.nick, 'fast');
      teachers.forEach(t => send(t, { type: 'flag', nick: s.nick, kind: 'fast', count: s.fastAnswers }));
    }

    send(ws, { type: 'answered', correct, points, basePoints, speedBonus, streakBonus, streak: s.streak, picked });
    broadcastTeacher();
    maybeEndRound();
    return;
  }

  if (msg.type === 'tableave') {
    s.tabLeaves++;
    if (!session.test) db.recordEvent(session.id, s.nick, 'tableave');
    teachers.forEach(t => send(t, { type: 'flag', nick: s.nick, kind: 'tableave', count: s.tabLeaves }));
    broadcastTeacher();
  }
}

// Сводная аналитика. stream (число) ограничивает данные одним потоком; null/undefined — все.
function statsData(stream) {
  stream = (stream == null || stream === 'all') ? null : Number(stream);
  if (!Number.isFinite(stream)) stream = null;
  const sessions = db.listSessions(stream).map(s => ({
    id: s.id, date: s.date, stream: s.stream, status: s.status,
    started_at: s.started_at || null, finished_at: s.finished_at || null,
    students: s.students || 0, answers: s.answers || 0, correct: s.correct || 0,
    accuracy: s.answers ? Math.round((s.correct / s.answers) * 100) : 0,
    avgScore: s.avgScore != null ? Math.round(s.avgScore) : null
  }));
  const tasks = db.taskStats(stream).map(t => {
    const meta = BY_ID.get(t.taskId);
    return {
      id: t.taskId,
      title: meta ? meta.title : t.taskId,
      prompt: meta ? meta.prompt : '',
      topic: meta ? meta.topic : '',
      type: meta ? meta.type : '',
      level: meta ? (meta.level || 1) : 1,
      attempts: t.attempts || 0,
      correct: t.correct || 0,
      accuracy: t.attempts ? Math.round((t.correct / t.attempts) * 100) : 0,
      avgMs: t.avgMs != null ? Math.round(t.avgMs) : null
    };
  });
  const students = db.studentStats(stream).map(s => {
    const topicMap = new Map();
    for (const tr of (s.taskRows || [])) {
      const meta = BY_ID.get(tr.taskId);
      const topic = meta ? meta.topic : 'other';
      const cur = topicMap.get(topic) || { topic, attempts: 0, correct: 0 };
      cur.attempts += tr.attempts; cur.correct += tr.correct;
      topicMap.set(topic, cur);
    }
    const suspicion = (s.tabLeaves || 0) + 2 * (s.fastAnswers || 0);   // индекс подозрительности
    return {
      nick: s.nick, icon: s.icon, sessions: s.sessions,
      answers: s.answers, correct: s.correct, accuracy: s.accuracy,
      avgMs: s.avgMs != null ? Math.round(s.avgMs) : null,
      avgScore: s.avgScore != null ? Math.round(s.avgScore) : null,
      bestPlace: s.bestPlace, tabLeaves: s.tabLeaves, fastAnswers: s.fastAnswers || 0,
      suspicion, suspect: suspicion >= (AC.suspectThreshold || 4),
      topics: [...topicMap.values()],
      sessionRows: (s.sessionRows || []).map(r => ({ ...r, avgMs: r.avgMs != null ? Math.round(r.avgMs) : null }))
    };
  });
  // Журнал посещаемости: список логинов и id посещённых сессий (колонки берём из sessions).
  const attendance = db.attendanceMap(stream);
  return { sessions, tasks, students, attendance, stream: stream == null ? 'all' : stream, backend: db.backend };
}

// Готовит листы для Excel-экспорта аналитики (Логины / Задачи / Сессии / Посещаемость).
function analyticsSheets(stream) {
  const d = statsData(stream);
  const ms = v => v == null ? '' : +(v / 1000).toFixed(1);
  const topicName = { asd: 'АиСД', graphs: 'Графы' };
  const typeName = { choice: 'выбор', graph: 'построение' };

  const students = [['Логин', 'Сессий', 'Ответов', 'Верных', 'Точность %', 'Ср. балл', 'Лучшее место', 'Уходы со вкладки', 'Быстрые ответы', 'Индекс подозр.', 'Подозрит.']];
  for (const s of d.students) students.push([
    s.nick, s.sessions, s.answers, s.correct, s.accuracy,
    s.avgScore != null ? s.avgScore : '', s.bestPlace != null ? s.bestPlace : '',
    s.tabLeaves || 0, s.fastAnswers || 0, s.suspicion || 0, s.suspect ? 'да' : ''
  ]);

  const tasks = [['ID', 'Задача', 'Тема', 'Тип', 'Сложность', 'Попыток', 'Верных', 'Точность %', 'Ср. время, с']];
  for (const t of d.tasks) tasks.push([
    t.id, t.title, topicName[t.topic] || t.topic, typeName[t.type] || t.type, t.level,
    t.attempts, t.correct, t.accuracy, ms(t.avgMs)
  ]);

  const sessions = [['#', 'Дата', 'Поток', 'Статус', 'Участников', 'Ответов', 'Верных', 'Точность %', 'Ср. балл']];
  for (const s of d.sessions) sessions.push([
    s.id, s.date || '', s.stream != null ? s.stream : '', s.status,
    s.students, s.answers, s.correct, s.accuracy, s.avgScore != null ? s.avgScore : ''
  ]);

  // Посещаемость: матрица логин × сессия (колонки — «#id дата»).
  const cols = d.sessions.slice().sort((a, b) => a.id - b.id);
  const header = ['Логин', ...cols.map(c => `#${c.id} ${c.date || ''}${c.stream != null ? ' (п' + c.stream + ')' : ''}`), 'Всего'];
  const att = [header];
  for (const a of d.attendance) {
    const set = new Set(a.sessionIds || []);
    const row = [a.nick, ...cols.map(c => set.has(c.id) ? '✓' : ''), set.size];
    att.push(row);
  }

  return [
    { name: 'Логины', rows: students },
    { name: 'Задачи', rows: tasks },
    { name: 'Сессии', rows: sessions },
    { name: 'Посещаемость', rows: att }
  ];
}

function handleTeacher(ws, msg) {
  if (msg.type === 'getStats') {
    try { send(ws, { type: 'stats', ...statsData(msg.stream) }); }
    catch (e) { send(ws, { type: 'stats', sessions: [], tasks: [], backend: db.backend, error: String(e.message || e) }); }
    return;
  }
  if (msg.type === 'wipeData') {
    try { db.wipeAll(); send(ws, { type: 'wiped', ok: true }); send(ws, { type: 'stats', ...statsData(null) }); }
    catch (e) { send(ws, { type: 'wiped', ok: false, error: String(e.message || e) }); }
    return;
  }
  if (msg.type === 'addTask') {
    const t = buildCustomTask(msg.task);
    if (!t) { send(ws, { type: 'taskAdded', ok: false, error: 'Некорректная задача: проверьте обязательные поля.' }); return; }
    if (TASKS.some(x => x.id === t.id)) { send(ws, { type: 'taskAdded', ok: false, error: 'Задача с таким кодом уже существует.' }); return; }
    TASKS.push(t);
    customSpecs.push(Object.assign({}, msg.task, { id: t.id }));
    saveCustomTasks();
    rebuildBank();
    teachers.forEach(w => {
      send(w, { type: 'catalog', items: catalogData() });
      send(w, { type: 'answerkey', items: answerKeyData() });
    });
    send(ws, { type: 'taskAdded', ok: true, id: t.id, title: t.title });
    return;
  }
  if (msg.type === 'deleteTask' && msg.id) {
    const idx = TASKS.findIndex(x => x.id === msg.id && x.custom);
    if (idx < 0) { send(ws, { type: 'taskAdded', ok: false, error: 'Удалять можно только собственные задачи.' }); return; }
    TASKS.splice(idx, 1);
    customSpecs = customSpecs.filter(s => s.id !== msg.id);
    saveCustomTasks();
    rebuildBank();
    teachers.forEach(w => {
      send(w, { type: 'catalog', items: catalogData() });
      send(w, { type: 'answerkey', items: answerKeyData() });
    });
    send(ws, { type: 'taskAdded', ok: true, deleted: msg.id });
    return;
  }
  if (msg.type === 'start' && session.status === 'lobby') {
    // Если учитель выбрал задачи вручную — берём их (в заданном порядке, без дублей);
    // иначе — обычный отбор по config (демо/POOL).
    if (Array.isArray(msg.taskIds) && msg.taskIds.length) {
      const seen = new Set();
      order = msg.taskIds
        .filter(id => !seen.has(id) && seen.add(id))
        .map(id => BY_ID.get(id))
        .filter(Boolean);
    } else {
      order = selectTasks();
    }
    if (!order.length) return;
    // Параметризация чисел: свежие значения на каждую игру (sort и др.).
    // Делаем КОПИИ — банк не мутируется. Ключ ответа у преподавателя берётся
    // из этого же объекта, поэтому остаётся согласованным.
    if (!config.paramize || config.paramize.enabled !== false)
      order = order.map(paramizeTask);
    // Тестовая сессия: результаты НЕ пишем в БД. Создаём запись (и пишем посещаемость)
    // только для обычной сессии.
    session.test = !!msg.test;
    if (session.test) {
      session.id = 'test-' + Date.now();
    } else {
      session.id = db.createSession(currentStream);
      db.setSessionStatus(session.id, 'running');
      for (const [nick, s] of byNick) db.recordAttendance(session.id, nick, s.icon, s.ip);
    }
    session.status = 'running';
    intermission = false;
    beginRound(0);
  }
  if (msg.type === 'finish' && session.status === 'running') {
    clearTimeout(roundTimer); roundTimer = null; intermission = false;
    finishGame();
  }
  if (msg.type === 'pause') { pauseRound(); return; }
  if (msg.type === 'resume') { resumeRound(); return; }
  if (msg.type === 'skip') { skipRound(); return; }
  if (msg.type === 'addTime') { addRoundTime(typeof msg.ms === 'number' ? msg.ms : 15000); return; }
  if (msg.type === 'kick' && msg.nick) {
    const s = byNick.get(msg.nick);
    if (s) {
      s.kicked = true;
      roundAnswered.delete(s.nick);
      for (const [ws, st] of students) {
        if (st === s) { send(ws, { type: 'kicked' }); students.delete(ws); try { ws.close(); } catch {} }
      }
      byNick.delete(msg.nick);
      broadcastTeacher();
      if (session.status === 'running' && !intermission) maybeEndRound();
    }
  }
  // Смена потока — только в лобби. Меняем номер и обновляем запись текущей сессии.
  if (msg.type === 'setStream' && session.status === 'lobby') {
    const n = parseInt(msg.stream, 10);
    if (Number.isFinite(n) && n > 0 && n < 100000) {
      currentStream = n;
      // Запись сессии в лобби ещё не создана (создаётся на старте) — просто меняем номер.
      try { if (session.id && !session.test) db.setSessionStream(session.id, n); } catch {}
      broadcastTeacher();
    }
    return;
  }
  if (msg.type === 'reset') {
    clearTimeout(roundTimer); roundTimer = null;
    session = { id: null, status: 'lobby', test: false };
    students.clear(); byNick.clear();
    order = []; round = -1; roundAnswered = new Set(); roundPerm = null; intermission = false;
    paused = false; pauseRemain = 0;
    broadcastTeacher();
  }
}

/* ---------- старт ---------- */
function localIps() {
  const out = [];
  Object.values(os.networkInterfaces()).flat().forEach(i => {
    if (i && i.family === 'IPv4' && !i.internal) out.push(i.address);
  });
  return out;
}
server.listen(PORT, () => {
  buildQr();
  console.log(`\n  AlgoClimb запущен (хранилище: ${db.backend})`);
  console.log(`  ┌────────────────────────────────────────────┐`);
  console.log(`  │  КЛЮЧ ПРЕПОДАВАТЕЛЯ:  ${TEACHER_KEY}                │`);
  console.log(`  │  (введите его на экране учителя; НЕ показывайте студентам) │`);
  console.log(`  └────────────────────────────────────────────┘`);
  console.log(`  Преподаватель:  http://localhost:${PORT}/teacher`);
  if (HOST_IP) console.log(`  Студенты:       http://${HOST_IP}:${PORT}/  (HOST_IP)`);
  localIps().forEach(ip => console.log(`  Студенты:       http://${ip}:${PORT}/`));
  const demo = config.demo || {};
  console.log(`  Режим: ${demo.enabled ? `демо — ${demo.count} случайных задач` : `все ${POOL.length} задач`} · таймер: выбор ${TIME.choice}с / граф ${TIME.graph}с`);
  console.log(`  IP-allowlist: ${config.ipAllowlist.enabled ? 'ВКЛ' : 'выкл'} · QR-ротация: ${config.qrRotation.enabled ? 'ВКЛ' : 'выкл'} · Debug: ${config.debug.enabled ? 'ВКЛ' : 'выкл'}`);
  if (config.debug.enabled) {
    console.log(`\n  ── DEBUG ВКЛ — тестирование с этой машины ──`);
    console.log(`  Лаунчер (все экраны):  http://localhost:${PORT}/debug`);
    console.log(`  Преподаватель:         http://localhost:${PORT}/teacher`);
    console.log(`  Студент:               http://localhost:${PORT}/   (открой в неск. вкладках)`);
    console.log(`  Ключ ответов:          http://localhost:${PORT}/answers`);
    console.log(`  С localhost вход студентом проходит БЕЗ кода/QR, даже в secure-режиме.`);
  }
  console.log('');
});
