"""Personal identities, one-use out-of-band invitations and scoped authorization."""

import hashlib
import json
import secrets
import time

from fastapi import HTTPException

import catalog
import db

COOKIE = "ac_login"


def init():
    with db._lock, db._conn:
        db._conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
          subject TEXT NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL,
          sections TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
          suspend_after INTEGER NOT NULL DEFAULT 0, can_publish INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS account_tokens (
          hash TEXT PRIMARY KEY, user_id TEXT, email TEXT, kind TEXT NOT NULL,
          sections TEXT NOT NULL DEFAULT '[]', expires INTEGER NOT NULL, used INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS account_logins (
          hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS room_owners (
          room TEXT PRIMARY KEY, owner_id TEXT NOT NULL, created INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_owners (
          session_id INTEGER PRIMARY KEY, owner_id TEXT NOT NULL, room TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_readers (
          session_id INTEGER NOT NULL, email TEXT NOT NULL, sections TEXT NOT NULL,
          granted_by TEXT NOT NULL, PRIMARY KEY(session_id,email)
        );
        CREATE INDEX IF NOT EXISTS idx_session_readers_email ON session_readers(email,session_id);
        CREATE TABLE IF NOT EXISTS teacher_sets (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, section TEXT NOT NULL,
          title TEXT NOT NULL, tasks TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'personal'
        );
        CREATE TABLE IF NOT EXISTS teacher_requests (
          id INTEGER PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL,
          title TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
          reply TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS account_audit (
          id INTEGER PRIMARY KEY, actor TEXT, action TEXT, target TEXT, at INTEGER
        );
        CREATE TABLE IF NOT EXISTS attendance_checks (
          room TEXT NOT NULL, nick TEXT NOT NULL, status TEXT NOT NULL,
          distance REAL, accuracy REAL, reviewed_by TEXT, at INTEGER,
          PRIMARY KEY(room,nick)
        );
        CREATE INDEX IF NOT EXISTS idx_session_owners_user ON session_owners(owner_id,session_id);
        """)
        cols = {r[1] for r in db._conn.execute("PRAGMA table_info(developer_keys)")}
        if "owner_id" not in cols:
            db._conn.execute("ALTER TABLE developer_keys ADD COLUMN owner_id TEXT")
        cols = {r[1] for r in db._conn.execute("PRAGMA table_info(answers)")}
        for name, declaration in (
            ("answer_text", "TEXT"),
            ("points", "INTEGER"),
            ("payload_json", "TEXT"),
        ):
            if name not in cols:
                db._conn.execute(f"ALTER TABLE answers ADD COLUMN {name} {declaration}")


def audit(actor, action, target):
    db._exec(
        "INSERT INTO account_audit(actor,action,target,at) VALUES(?,?,?,?)",
        (actor, action, target, int(time.time())),
    )


def initialized():
    return bool(db._all("SELECT id FROM users WHERE role='admin' LIMIT 1"))


def password_hash(password):
    if not isinstance(password, str) or not 10 <= len(password) <= 256:
        raise HTTPException(400, "Password must contain 10 to 256 characters.")
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 600000).hex()
    return salt + ":" + digest


def password_ok(password, saved):
    if not isinstance(password, str) or len(password) > 256:
        return False
    salt, digest = saved.split(":")
    actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 600000).hex()
    return secrets.compare_digest(actual, digest)


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def user(user_id):
    rows = db._all("SELECT * FROM users WHERE id=?", (user_id,))
    if not rows:
        return None
    row = rows[0]
    row["sections"] = json.loads(row["sections"])
    return row


def public(u):
    return {k: v for k, v in u.items() if k != "password"}


def current(request, admin=False):
    token = request.cookies.get(COOKIE, "")
    rows = (
        db._all(
            "SELECT user_id FROM account_logins WHERE hash=? AND expires>?",
            (digest(token), int(time.time())),
        )
        if token
        else []
    )
    u = user(rows[0]["user_id"]) if rows else None
    if not u or not u["active"]:
        raise HTTPException(401, "Sign in to continue.")
    if admin and u["role"] != "admin":
        raise HTTPException(403, "Administrator access required.")
    return u


def sections(u):
    return list(catalog.SECTIONS) if u["role"] == "admin" else u["sections"]


def visible_sessions(u, limit=200, offset=0):
    if u["role"] == "admin":
        return db.history_sessions(limit, offset)
    return db._all(
        "SELECT s.* FROM sessions s WHERE EXISTS (SELECT 1 FROM session_owners o WHERE o.session_id=s.id AND o.owner_id=?) OR EXISTS (SELECT 1 FROM session_readers r WHERE r.session_id=s.id AND r.email=?) ORDER BY s.id DESC LIMIT ? OFFSET ?",
        (u["id"], u["email"], limit, offset),
    )


def own_session(u, sid):
    owners = db._all("SELECT owner_id FROM session_owners WHERE session_id=?", (sid,))
    grants = db._all(
        "SELECT sections FROM session_readers WHERE session_id=? AND email=?", (sid, u["email"])
    )
    owned = bool(owners and owners[0]["owner_id"] == u["id"])
    if u["role"] != "admin" and not owned and not grants:
        raise HTTPException(404, "Session not found.")
    meta = db.get_session_metadata(sid) or {}
    required = meta.get("sections", [])
    if grants and not required:
        required = json.loads(grants[0]["sections"])
    if u["role"] != "admin" and not set(required).issubset(sections(u)):
        raise HTTPException(403, "Subject access has been revoked.")


def revoke_all(uid):
    with db._lock, db._conn:
        db._conn.execute("DELETE FROM account_logins WHERE user_id=?", (uid,))
        db._conn.execute("UPDATE developer_keys SET revoked=1 WHERE owner_id=?", (uid,))


def personal_tasks(u):
    rows = db._all("SELECT * FROM teacher_sets WHERE owner_id=? OR visibility='shared'", (u["id"],))
    result = []
    for row in rows:
        if row["section"] in sections(u):
            result.extend(json.loads(row["tasks"]))
    return result


def catalog_tasks(u):
    return [t for t in bank_tasks() if catalog.section_for(t) in sections(u)] + personal_tasks(u)


def bank_tasks():
    import bank

    return bank.TASKS


init()
