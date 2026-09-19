"""
Хранилище на SQLite — источник правды (Python-порт db.js).

Схема идентична Node-версии, поэтому файл data/algoclimb.db совместим между
бэкендами. История сессий, ответов, результатов и событий сохраняется на диске
(в примонтированном на VPS томе) и переживает перезапуск приложения.
"""
from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "algoclimb.db"

backend = "sqlite"
_lock = threading.Lock()
_conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
_conn.row_factory = sqlite3.Row
_conn.execute("PRAGMA journal_mode = WAL;")
_conn.executescript(
    """
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
    """
)
_conn.commit()


def _now():
    return datetime.now(timezone.utc).isoformat()


def _exec(sql, args=()):
    with _lock:
        cur = _conn.execute(sql, args)
        _conn.commit()
        return cur


def _all(sql, args=()):
    with _lock:
        return [dict(r) for r in _conn.execute(sql, args).fetchall()]


def wipe_all():
    with _lock:
        for t in ("answers", "results", "events", "attendance", "sessions"):
            _conn.execute("DELETE FROM " + t + ";")
        try:
            _conn.execute("DELETE FROM sqlite_sequence;")
        except sqlite3.Error:
            pass
        _conn.commit()
    try:
        _conn.execute("VACUUM;")
    except sqlite3.Error:
        pass
    return True


def create_session(stream):
    date = _now()[:10]
    cur = _exec("INSERT INTO sessions(date,stream,status,started_at) VALUES(?,?,?,?)",
                (date, stream, "lobby", None))
    return cur.lastrowid


def set_session_status(sid, status):
    ts = _now()
    _exec("UPDATE sessions SET status=? WHERE id=?", (status, sid))
    col = "started_at" if status == "running" else "finished_at" if status == "finished" else None
    if col:
        _exec("UPDATE sessions SET %s=? WHERE id=?" % col, (ts, sid))


def set_session_stream(sid, stream):
    _exec("UPDATE sessions SET stream=? WHERE id=?", (stream, sid))


def record_attendance(sid, nick, icon, ip):
    _exec("INSERT INTO attendance(session_id,nick,icon,ip,joined_at) VALUES(?,?,?,?,?)",
          (sid, nick, icon, ip, _now()))


def record_answer(sid, nick, task_id, correct, duration_ms):
    _exec("INSERT INTO answers(session_id,nick,task_id,correct,duration_ms,submitted_at) VALUES(?,?,?,?,?,?)",
          (sid, nick, task_id, 1 if correct else 0, duration_ms, _now()))


def record_result(sid, nick, base, mult, total, place):
    _exec("INSERT INTO results(session_id,nick,base_points,multiplier,total,place) VALUES(?,?,?,?,?,?)",
          (sid, nick, base, mult, total, place))


def record_event(sid, nick, kind):
    _exec("INSERT INTO events(session_id,nick,kind,at) VALUES(?,?,?,?)", (sid, nick, kind, _now()))


# ------------------------------------------------------------------ чтение для аналитики
def list_sessions(stream):
    rows = _all(
        """
        SELECT s.id, s.date, s.stream, s.status, s.started_at, s.finished_at,
          (SELECT COUNT(*) FROM attendance a WHERE a.session_id=s.id) AS students,
          (SELECT COUNT(*) FROM answers an WHERE an.session_id=s.id) AS answers,
          (SELECT COALESCE(SUM(an.correct),0) FROM answers an WHERE an.session_id=s.id) AS correct,
          (SELECT AVG(r.total) FROM results r WHERE r.session_id=s.id) AS avgScore
        FROM sessions s ORDER BY s.id DESC
        """
    )
    if stream is not None:
        rows = [r for r in rows if r["stream"] == stream]
    return rows


def task_stats(stream):
    if stream is not None:
        return _all(
            """
            SELECT a.task_id AS taskId, COUNT(*) AS attempts,
              COALESCE(SUM(a.correct),0) AS correct, AVG(a.duration_ms) AS avgMs
            FROM answers a JOIN sessions s ON s.id=a.session_id
            WHERE s.stream=? GROUP BY a.task_id ORDER BY attempts DESC, taskId ASC
            """, (stream,))
    return _all(
        """
        SELECT task_id AS taskId, COUNT(*) AS attempts,
          COALESCE(SUM(correct),0) AS correct, AVG(duration_ms) AS avgMs
        FROM answers GROUP BY task_id ORDER BY attempts DESC, taskId ASC
        """)


def _stream_session_ids(stream):
    if stream is None:
        return None
    return {r["id"] for r in _all("SELECT id FROM sessions WHERE stream=?", (stream,))}


def student_stats(stream):
    answers = _all("SELECT session_id AS sessionId, nick, task_id AS taskId, correct, duration_ms AS durationMs FROM answers")
    for a in answers:
        a["correct"] = bool(a["correct"])
    results = _all("SELECT session_id AS sessionId, nick, total, place FROM results")
    attendance = _all("SELECT session_id AS sessionId, nick, icon FROM attendance")
    events = _all("SELECT session_id AS sessionId, nick, kind FROM events")
    sess_meta = {r["id"]: {"date": r["date"], "stream": r["stream"]}
                 for r in _all("SELECT id, date, stream FROM sessions")}

    allowed = _stream_session_ids(stream)
    if allowed is not None:
        answers = [a for a in answers if a["sessionId"] in allowed]
        results = [r for r in results if r["sessionId"] in allowed]
        attendance = [a for a in attendance if a["sessionId"] in allowed]
        events = [e for e in events if e["sessionId"] in allowed]
    return _aggregate_students(answers, results, attendance, events, sess_meta)


def _aggregate_students(answers, results, attendance, events, sess_meta):
    m = {}

    def get(nick):
        c = m.get(nick)
        if not c:
            c = {"nick": nick, "icon": "", "sessionsSet": set(), "answers": 0, "correct": 0,
                 "msSum": 0, "msN": 0, "totalSum": 0.0, "totalN": 0, "bestPlace": None,
                 "tabLeaves": 0, "fastAnswers": 0, "byTask": {}, "bySession": {}}
            m[nick] = c
        return c

    def sk(c, sid):
        s = c["bySession"].get(sid)
        if not s:
            s = {"sessionId": sid, "answers": 0, "correct": 0, "msSum": 0, "msN": 0,
                 "score": None, "place": None}
            c["bySession"][sid] = s
        return s

    for a in attendance:
        if a.get("nick") is None:
            continue
        c = get(a["nick"])
        if a.get("icon") and not c["icon"]:
            c["icon"] = a["icon"]
        if a.get("sessionId") is not None:
            c["sessionsSet"].add(a["sessionId"])

    for a in answers:
        if a.get("nick") is None:
            continue
        c = get(a["nick"])
        corr = 1 if a["correct"] else 0
        c["answers"] += 1
        c["correct"] += corr
        if isinstance(a.get("durationMs"), (int, float)):
            c["msSum"] += a["durationMs"]
            c["msN"] += 1
        if a.get("sessionId") is not None:
            c["sessionsSet"].add(a["sessionId"])
        tk = c["byTask"].get(a["taskId"]) or {"taskId": a["taskId"], "attempts": 0, "correct": 0}
        tk["attempts"] += 1
        tk["correct"] += corr
        c["byTask"][a["taskId"]] = tk
        s = sk(c, a["sessionId"])
        s["answers"] += 1
        s["correct"] += corr
        if isinstance(a.get("durationMs"), (int, float)):
            s["msSum"] += a["durationMs"]
            s["msN"] += 1

    for r in results:
        if r.get("nick") is None:
            continue
        c = get(r["nick"])
        if isinstance(r.get("total"), (int, float)):
            c["totalSum"] += r["total"]
            c["totalN"] += 1
        if r.get("place") is not None and (c["bestPlace"] is None or r["place"] < c["bestPlace"]):
            c["bestPlace"] = r["place"]
        if r.get("sessionId") is not None:
            c["sessionsSet"].add(r["sessionId"])
            s = sk(c, r["sessionId"])
            if r.get("total") is not None:
                s["score"] = r["total"]
            if r.get("place") is not None:
                s["place"] = r["place"]

    for e in events:
        if e.get("nick") is None:
            continue
        if e["kind"] == "tableave":
            get(e["nick"])["tabLeaves"] += 1
        elif e["kind"] == "fast":
            get(e["nick"])["fastAnswers"] += 1

    out = []
    for c in m.values():
        session_rows = []
        for s in c["bySession"].values():
            meta = sess_meta.get(s["sessionId"], {})
            session_rows.append({
                "sessionId": s["sessionId"], "date": meta.get("date") or "",
                "stream": meta.get("stream"),
                "answers": s["answers"], "correct": s["correct"],
                "accuracy": round(s["correct"] / s["answers"] * 100) if s["answers"] else 0,
                "avgMs": (s["msSum"] / s["msN"]) if s["msN"] else None,
                "score": s["score"], "place": s["place"],
            })
        session_rows.sort(key=lambda r: r["sessionId"], reverse=True)
        out.append({
            "nick": c["nick"], "icon": c["icon"], "sessions": len(c["sessionsSet"]),
            "answers": c["answers"], "correct": c["correct"],
            "accuracy": round(c["correct"] / c["answers"] * 100) if c["answers"] else 0,
            "avgMs": (c["msSum"] / c["msN"]) if c["msN"] else None,
            "avgScore": (c["totalSum"] / c["totalN"]) if c["totalN"] else None,
            "bestPlace": c["bestPlace"], "tabLeaves": c["tabLeaves"],
            "fastAnswers": c["fastAnswers"],
            "taskRows": list(c["byTask"].values()), "sessionRows": session_rows,
        })
    out.sort(key=lambda a: (a["accuracy"], -a["answers"]))
    return out


def attendance_map(stream):
    rows = _all("SELECT session_id AS sessionId, nick, icon FROM attendance")
    allowed = _stream_session_ids(stream)
    if allowed is not None:
        rows = [a for a in rows if a["sessionId"] in allowed]
    m = {}
    for a in rows:
        if not a or a.get("nick") is None:
            continue
        c = m.get(a["nick"])
        if not c:
            c = {"nick": a["nick"], "icon": a.get("icon") or "", "set": set()}
            m[a["nick"]] = c
        if a.get("icon") and not c["icon"]:
            c["icon"] = a["icon"]
        if a.get("sessionId") is not None:
            c["set"].add(a["sessionId"])
    res = [{"nick": c["nick"], "icon": c["icon"], "sessionIds": list(c["set"])} for c in m.values()]
    res.sort(key=lambda a: a["nick"])
    return res
