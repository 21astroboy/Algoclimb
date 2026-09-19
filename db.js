/*
 * Хранилище на SQLite — источник правды.
 * Используется встроенный в Node модуль node:sqlite (без нативной сборки!).
 * Если рантайм его не поддерживает (старый Node) — падаем на JSONL-журнал в data/,
 * чтобы приложение всё равно запускалось и собирало данные.
 */
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

let backend = 'sqlite';
let db = null;

try {
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(path.join(DATA_DIR, 'algoclimb.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT, stream INTEGER, status TEXT, started_at TEXT, finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER, nick TEXT, icon TEXT, ip TEXT, joined_at TEXT
    );
    CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER, nick TEXT, task_id TEXT, correct INTEGER,
      duration_ms INTEGER, submitted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER, nick TEXT, base_points INTEGER,
      multiplier REAL, total REAL, place INTEGER
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER, nick TEXT, kind TEXT, at TEXT
    );
  `);
} catch (e) {
  backend = 'jsonl';
  console.warn('[db] node:sqlite недоступен (' + e.message.split('\n')[0] + '). Падаю на JSONL-журнал в data/. Обнови Node до 22+, чтобы писать в SQLite.');
}

function jlog(file, obj) {
  fs.appendFileSync(path.join(DATA_DIR, file), JSON.stringify(obj) + '\n');
}
const nowISO = () => new Date().toISOString();

module.exports = {
  backend,
  // Полная очистка всех данных о сессиях (безвозвратно). Банк задач не трогается.
  wipeAll() {
    if (backend === 'sqlite') {
      for (const t of ['answers', 'results', 'events', 'attendance', 'sessions']) db.exec('DELETE FROM ' + t + ';');
      try { db.exec('DELETE FROM sqlite_sequence;'); } catch (e) {}
      try { db.exec('VACUUM;'); } catch (e) {}
    } else {
      for (const f of ['sessions.jsonl', 'attendance.jsonl', 'answers.jsonl', 'results.jsonl', 'events.jsonl']) {
        try { fs.writeFileSync(path.join(DATA_DIR, f), ''); } catch (e) {}
      }
    }
    return true;
  },
  createSession(stream) {
    const date = nowISO().slice(0, 10);
    if (backend === 'sqlite') {
      const r = db.prepare('INSERT INTO sessions(date,stream,status,started_at) VALUES(?,?,?,?)')
        .run(date, stream, 'lobby', null);
      return r.lastInsertRowid;
    }
    const id = Date.now();
    jlog('sessions.jsonl', { id, date, stream, status: 'lobby' });
    return id;
  },
  setSessionStatus(id, status) {
    const ts = nowISO();
    if (backend === 'sqlite') {
      const col = status === 'running' ? 'started_at' : status === 'finished' ? 'finished_at' : null;
      db.prepare('UPDATE sessions SET status=? WHERE id=?').run(status, id);
      if (col) db.prepare(`UPDATE sessions SET ${col}=? WHERE id=?`).run(ts, id);
    } else jlog('sessions.jsonl', { id, status, ts });
  },
  setSessionStream(id, stream) {
    if (backend === 'sqlite')
      db.prepare('UPDATE sessions SET stream=? WHERE id=?').run(stream, id);
    else jlog('sessions.jsonl', { id, stream, ts: nowISO() });
  },
  recordAttendance(sessionId, nick, icon, ip) {
    if (backend === 'sqlite')
      db.prepare('INSERT INTO attendance(session_id,nick,icon,ip,joined_at) VALUES(?,?,?,?,?)')
        .run(sessionId, nick, icon, ip, nowISO());
    else jlog('attendance.jsonl', { sessionId, nick, icon, ip, joined_at: nowISO() });
  },
  recordAnswer(sessionId, nick, taskId, correct, durationMs) {
    if (backend === 'sqlite')
      db.prepare('INSERT INTO answers(session_id,nick,task_id,correct,duration_ms,submitted_at) VALUES(?,?,?,?,?,?)')
        .run(sessionId, nick, taskId, correct ? 1 : 0, durationMs, nowISO());
    else jlog('answers.jsonl', { sessionId, nick, taskId, correct, durationMs, at: nowISO() });
  },
  recordResult(sessionId, nick, base, mult, total, place) {
    if (backend === 'sqlite')
      db.prepare('INSERT INTO results(session_id,nick,base_points,multiplier,total,place) VALUES(?,?,?,?,?,?)')
        .run(sessionId, nick, base, mult, total, place);
    else jlog('results.jsonl', { sessionId, nick, base, mult, total, place });
  },
  recordEvent(sessionId, nick, kind) {
    if (backend === 'sqlite')
      db.prepare('INSERT INTO events(session_id,nick,kind,at) VALUES(?,?,?,?)')
        .run(sessionId, nick, kind, nowISO());
    else jlog('events.jsonl', { sessionId, nick, kind, at: nowISO() });
  },

  /* ---------- ЧТЕНИЕ для аналитики ----------
   * Все методы принимают необязательный фильтр по потоку (stream).
   * stream == null  → данные по всем потокам; число → только этот поток. */
  // Список сессий с агрегатами: число участников, ответов, верных, средний балл.
  listSessions(stream) {
    if (backend === 'sqlite') {
      return db.prepare(`
        SELECT s.id, s.date, s.stream, s.status, s.started_at, s.finished_at,
          (SELECT COUNT(*) FROM attendance a WHERE a.session_id=s.id) AS students,
          (SELECT COUNT(*) FROM answers an WHERE an.session_id=s.id) AS answers,
          (SELECT COALESCE(SUM(an.correct),0) FROM answers an WHERE an.session_id=s.id) AS correct,
          (SELECT AVG(r.total) FROM results r WHERE r.session_id=s.id) AS avgScore
        FROM sessions s ORDER BY s.id DESC
      `).all().map(r => ({ ...r, avgScore: r.avgScore }))
        .filter(r => stream == null || r.stream === stream);
    }
    // JSONL: собираем вручную.
    const sess = readJsonl('sessions.jsonl');
    const att = readJsonl('attendance.jsonl');
    const ans = readJsonl('answers.jsonl');
    const res = readJsonl('results.jsonl');
    const byId = new Map();
    for (const e of sess) {
      if (e.id == null) continue;
      const cur = byId.get(e.id) || { id: e.id, date: e.date, stream: e.stream, status: e.status, started_at: null, finished_at: null };
      if (e.date) cur.date = e.date;
      if (e.stream != null) cur.stream = e.stream;
      if (e.status) { cur.status = e.status; if (e.status === 'running') cur.started_at = e.ts || cur.started_at; if (e.status === 'finished') cur.finished_at = e.ts || cur.finished_at; }
      byId.set(e.id, cur);
    }
    const count = (arr, id) => arr.filter(x => x.sessionId === id).length;
    const out = [];
    for (const cur of byId.values()) {
      const a = ans.filter(x => x.sessionId === cur.id);
      const r = res.filter(x => x.sessionId === cur.id);
      out.push({
        ...cur,
        students: count(att, cur.id),
        answers: a.length,
        correct: a.filter(x => x.correct).length,
        avgScore: r.length ? r.reduce((s, x) => s + (x.total || 0), 0) / r.length : null
      });
    }
    out.sort((x, y) => (y.id > x.id ? 1 : y.id < x.id ? -1 : 0));
    return stream == null ? out : out.filter(s => s.stream === stream);
  },

  // Статистика по каждой задаче: попытки, верных, среднее время (опц. по потоку).
  taskStats(stream) {
    if (backend === 'sqlite') {
      if (stream != null) {
        return db.prepare(`
          SELECT a.task_id AS taskId, COUNT(*) AS attempts,
            COALESCE(SUM(a.correct),0) AS correct, AVG(a.duration_ms) AS avgMs
          FROM answers a JOIN sessions s ON s.id=a.session_id
          WHERE s.stream=? GROUP BY a.task_id ORDER BY attempts DESC, taskId ASC
        `).all(stream);
      }
      return db.prepare(`
        SELECT task_id AS taskId, COUNT(*) AS attempts,
          COALESCE(SUM(correct),0) AS correct, AVG(duration_ms) AS avgMs
        FROM answers GROUP BY task_id ORDER BY attempts DESC, taskId ASC
      `).all();
    }
    const allowed = streamSessionIds(stream);
    let ans = readJsonl('answers.jsonl');
    if (allowed) ans = ans.filter(a => allowed.has(a.sessionId));
    const m = new Map();
    for (const a of ans) {
      const id = a.taskId; if (id == null) continue;
      const cur = m.get(id) || { taskId: id, attempts: 0, correct: 0, msSum: 0, msN: 0 };
      cur.attempts++;
      if (a.correct) cur.correct++;
      if (typeof a.durationMs === 'number') { cur.msSum += a.durationMs; cur.msN++; }
      m.set(id, cur);
    }
    return [...m.values()]
      .map(c => ({ taskId: c.taskId, attempts: c.attempts, correct: c.correct, avgMs: c.msN ? c.msSum / c.msN : null }))
      .sort((a, b) => b.attempts - a.attempts || (a.taskId < b.taskId ? -1 : 1));
  },

  // Статистика по каждому логину (нику) по всем сессиям: участие, точность, баллы,
  // лучшее место, уходы со вкладки, разбивка по сессиям и сырые данные по задачам
  // (topic досчитывается на сервере по BY_ID).
  studentStats(stream) {
    let answers, results, attendance, events, sessMeta;
    if (backend === 'sqlite') {
      answers = db.prepare('SELECT session_id AS sessionId, nick, task_id AS taskId, correct, duration_ms AS durationMs FROM answers').all()
        .map(a => ({ ...a, correct: !!a.correct }));
      results = db.prepare('SELECT session_id AS sessionId, nick, total, place FROM results').all();
      attendance = db.prepare('SELECT session_id AS sessionId, nick, icon FROM attendance').all();
      events = db.prepare('SELECT session_id AS sessionId, nick, kind FROM events').all();
      sessMeta = new Map(db.prepare('SELECT id, date, stream FROM sessions').all().map(s => [s.id, { date: s.date, stream: s.stream }]));
    } else {
      answers = readJsonl('answers.jsonl');
      results = readJsonl('results.jsonl');
      attendance = readJsonl('attendance.jsonl');
      events = readJsonl('events.jsonl');
      sessMeta = new Map();
      for (const e of readJsonl('sessions.jsonl')) {
        if (e.id == null) continue;
        const cur = sessMeta.get(e.id) || { date: null, stream: null };
        if (e.date != null) cur.date = e.date;
        if (e.stream != null) cur.stream = e.stream;
        sessMeta.set(e.id, cur);
      }
    }
    // Фильтр по потоку: оставляем только записи сессий выбранного потока.
    const allowed = streamSessionIds(stream);
    if (allowed) {
      answers = answers.filter(a => allowed.has(a.sessionId));
      results = results.filter(r => allowed.has(r.sessionId));
      attendance = attendance.filter(a => allowed.has(a.sessionId));
      events = events.filter(e => allowed.has(e.sessionId));
    }
    return aggregateStudents(answers, results, attendance, events, sessMeta);
  },

  // Журнал посещаемости: какие сессии посетил каждый логин (для матрицы логин×лекция).
  attendanceMap(stream) {
    let rows;
    if (backend === 'sqlite')
      rows = db.prepare('SELECT session_id AS sessionId, nick, icon FROM attendance').all();
    else
      rows = readJsonl('attendance.jsonl');
    const allowed = streamSessionIds(stream);
    if (allowed) rows = rows.filter(a => allowed.has(a.sessionId));
    const m = new Map();
    for (const a of rows) {
      if (!a || a.nick == null) continue;
      let c = m.get(a.nick);
      if (!c) { c = { nick: a.nick, icon: a.icon || '', set: new Set() }; m.set(a.nick, c); }
      if (a.icon && !c.icon) c.icon = a.icon;
      if (a.sessionId != null) c.set.add(a.sessionId);
    }
    return [...m.values()].map(c => ({ nick: c.nick, icon: c.icon, sessionIds: [...c.set] }))
      .sort((a, b) => (a.nick < b.nick ? -1 : a.nick > b.nick ? 1 : 0));
  }
};

function aggregateStudents(answers, results, attendance, events, sessMeta) {
  const m = new Map();
  const get = nick => {
    let c = m.get(nick);
    if (!c) { c = { nick, icon: '', sessionsSet: new Set(), answers: 0, correct: 0, msSum: 0, msN: 0, totalSum: 0, totalN: 0, bestPlace: null, tabLeaves: 0, fastAnswers: 0, byTask: new Map(), bySession: new Map() }; m.set(nick, c); }
    return c;
  };
  const sk = (c, id) => {
    let s = c.bySession.get(id);
    if (!s) { s = { sessionId: id, answers: 0, correct: 0, msSum: 0, msN: 0, score: null, place: null }; c.bySession.set(id, s); }
    return s;
  };
  for (const a of attendance) {
    if (!a || a.nick == null) continue;
    const c = get(a.nick);
    if (a.icon && !c.icon) c.icon = a.icon;
    if (a.sessionId != null) c.sessionsSet.add(a.sessionId);
  }
  for (const a of answers) {
    if (!a || a.nick == null) continue;
    const c = get(a.nick);
    const corr = a.correct ? 1 : 0;
    c.answers++; if (corr) c.correct++;
    if (typeof a.durationMs === 'number') { c.msSum += a.durationMs; c.msN++; }
    if (a.sessionId != null) c.sessionsSet.add(a.sessionId);
    const tk = c.byTask.get(a.taskId) || { taskId: a.taskId, attempts: 0, correct: 0 };
    tk.attempts++; if (corr) tk.correct++; c.byTask.set(a.taskId, tk);
    const s = sk(c, a.sessionId);
    s.answers++; if (corr) s.correct++;
    if (typeof a.durationMs === 'number') { s.msSum += a.durationMs; s.msN++; }
  }
  for (const r of results) {
    if (!r || r.nick == null) continue;
    const c = get(r.nick);
    if (typeof r.total === 'number') { c.totalSum += r.total; c.totalN++; }
    if (r.place != null && (c.bestPlace == null || r.place < c.bestPlace)) c.bestPlace = r.place;
    if (r.sessionId != null) {
      c.sessionsSet.add(r.sessionId);
      const s = sk(c, r.sessionId);
      if (r.total != null) s.score = r.total;
      if (r.place != null) s.place = r.place;
    }
  }
  for (const e of events) {
    if (!e || e.nick == null) continue;
    if (e.kind === 'tableave') get(e.nick).tabLeaves++;
    else if (e.kind === 'fast') get(e.nick).fastAnswers = (get(e.nick).fastAnswers || 0) + 1;
  }
  const out = [];
  for (const c of m.values()) {
    const sessionRows = [...c.bySession.values()].map(s => {
      const meta = sessMeta.get(s.sessionId) || {};
      return {
        sessionId: s.sessionId, date: meta.date || '', stream: meta.stream != null ? meta.stream : null,
        answers: s.answers, correct: s.correct,
        accuracy: s.answers ? Math.round(s.correct / s.answers * 100) : 0,
        avgMs: s.msN ? s.msSum / s.msN : null, score: s.score, place: s.place
      };
    }).sort((a, b) => (b.sessionId > a.sessionId ? 1 : b.sessionId < a.sessionId ? -1 : 0));
    out.push({
      nick: c.nick, icon: c.icon, sessions: c.sessionsSet.size,
      answers: c.answers, correct: c.correct,
      accuracy: c.answers ? Math.round(c.correct / c.answers * 100) : 0,
      avgMs: c.msN ? c.msSum / c.msN : null,
      avgScore: c.totalN ? c.totalSum / c.totalN : null,
      bestPlace: c.bestPlace, tabLeaves: c.tabLeaves, fastAnswers: c.fastAnswers || 0,
      taskRows: [...c.byTask.values()], sessionRows
    });
  }
  out.sort((a, b) => a.accuracy - b.accuracy || b.answers - a.answers);
  return out;
}

// Множество id сессий, относящихся к указанному потоку (null/undefined → не фильтруем).
function streamSessionIds(stream) {
  if (stream == null) return null;
  const set = new Set();
  if (backend === 'sqlite') {
    for (const r of db.prepare('SELECT id FROM sessions WHERE stream=?').all(stream)) set.add(r.id);
    return set;
  }
  const m = new Map();
  for (const e of readJsonl('sessions.jsonl')) {
    if (e.id == null) continue;
    if (e.stream != null) m.set(e.id, e.stream);
  }
  for (const [id, st] of m) if (st === stream) set.add(id);
  return set;
}

function readJsonl(file) {
  try {
    const p = path.join(DATA_DIR, file);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
