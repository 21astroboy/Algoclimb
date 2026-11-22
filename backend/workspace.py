"""Account workspace HTTP API; all expensive reads run outside game locks."""

import asyncio
import json
import math
import secrets
import time
from collections import defaultdict, deque
from pathlib import Path

from fastapi import HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse

import accounts as ac
import catalog
import db
from developer_api import read_json as _read_json
from developer_api import session_info
from import_bank import validate_tasks

_ATTEMPTS: dict[str, deque] = defaultdict(deque)


async def read_json(request):
    value = await _read_json(request)
    if not isinstance(value, dict):
        raise HTTPException(400, "Provide a JSON object.")
    return value


def limited(request):
    # Do not trust arbitrary X-Forwarded-For. Uvicorn resolves trusted proxies.
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    if len(_ATTEMPTS) > 5000:
        for key in list(_ATTEMPTS):
            if not _ATTEMPTS[key] or _ATTEMPTS[key][-1] < now - 900:
                _ATTEMPTS.pop(key, None)
    q = _ATTEMPTS[ip]
    while q and q[0] < now - 900:
        q.popleft()
    if len(q) >= 20:
        raise HTTPException(429, "Too many attempts. Try again in 15 minutes.")
    q.append(now)


def text(body, key, maximum=160):
    value = body.get(key)
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= maximum:
        raise HTTPException(400, f"Provide {key} (1–{maximum} characters).")
    return value.strip()


def email(body):
    value = text(body, "email", 254).lower()
    if "@" not in value or " " in value:
        raise HTTPException(400, "Invalid email login.")
    return value


def allowed_sections(body):
    value = body.get("sections")
    if not isinstance(value, list) or not all(s in catalog.SECTIONS for s in value):
        raise HTTPException(400, "Choose valid subject sections.")
    return sorted(set(value))


def distance(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 6371000 * 2 * math.asin(min(1, math.sqrt(h)))


def coordinates(body):
    values = [body.get(k) for k in ("latitude", "longitude", "accuracy")]
    if any(type(v) not in (int, float) or not math.isfinite(v) for v in values):
        raise HTTPException(400, "Provide finite coordinates and accuracy.")
    lat, lon, accuracy = values
    if not -90 <= lat <= 90 or not -180 <= lon <= 180 or not 0 <= accuracy <= 100000:
        raise HTTPException(400, "Invalid coordinates or accuracy.")
    return lat, lon, accuracy


def geo_status(d, radius, uncertainty):
    if uncertainty > radius or abs(d - radius) <= uncertainty:
        return "needs_review"
    return "in_zone" if d + uncertainty < radius else "outside"


def register(app, rooms, new_room, teacher_key):
    def room_for(u, room_id):
        g = rooms.get(room_id)
        if g is None or (g.owner_id != u["id"] and u["role"] != "admin"):
            raise HTTPException(404, "Room not found.")
        return g

    def login_response(u, request):
        token = secrets.token_urlsafe(32)
        db._exec(
            "INSERT INTO account_logins VALUES(?,?,?)",
            (ac.digest(token), u["id"], int(time.time()) + 43200),
        )
        response = JSONResponse(ac.public(u))
        response.set_cookie(
            ac.COOKIE,
            token,
            httponly=True,
            secure=request.url.scheme == "https",
            samesite="strict",
            max_age=43200,
        )
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.middleware("http")
    async def workspace_safety(request, call_next):
        if request.url.path.startswith("/api/workspace") and request.method not in (
            "GET",
            "HEAD",
            "OPTIONS",
        ):
            origin = request.headers.get("origin")
            expected = f"{request.url.scheme}://{request.url.netloc}"
            if origin and origin != expected:
                return JSONResponse({"detail": "Cross-origin request blocked."}, 403)
        response = await call_next(request)
        if request.url.path.startswith("/api/workspace"):
            response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        return response

    @app.get("/workspace", response_class=HTMLResponse)
    async def workspace_page():
        return HTMLResponse(
            (Path(__file__).parent.parent / "frontend/workspace.html").read_text(),
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/api/workspace/status")
    async def setup_status():
        return {
            "initialized": ac.initialized(),
            "email_delivery": "administrator",
            "sections": catalog.SECTIONS,
        }

    @app.post("/api/workspace/setup")
    async def setup(request: Request):
        limited(request)
        body = await read_json(request)
        if ac.initialized():
            raise HTTPException(409, "Owner account already exists.")
        if not secrets.compare_digest(str(body.get("key", "")), teacher_key):
            raise HTTPException(401, "Invalid bootstrap key.")
        uid = secrets.token_hex(12)
        hashed = await asyncio.to_thread(ac.password_hash, body.get("password"))
        # Serialize the first-owner check to avoid parallel bootstrap races.
        with db._lock, db._conn:
            if db._conn.execute("SELECT 1 FROM users WHERE role='admin'").fetchone():
                raise HTTPException(409, "Owner account already exists.")
            db._conn.execute(
                "INSERT INTO users(id,email,name,subject,password,role,sections) VALUES(?,?,?,?,?,?,?)",
                (
                    uid,
                    email(body),
                    text(body, "name"),
                    text(body, "subject"),
                    hashed,
                    "admin",
                    json.dumps(list(catalog.SECTIONS)),
                ),
            )
            db._conn.execute("UPDATE developer_keys SET revoked=1 WHERE owner_id IS NULL")
        ac.audit(uid, "owner_created", uid)
        return login_response(ac.user(uid), request)

    @app.post("/api/workspace/login")
    async def login(request: Request):
        limited(request)
        body = await read_json(request)
        rows = db._all("SELECT id FROM users WHERE email=?", (email(body),))
        u = ac.user(rows[0]["id"]) if rows else None
        if (
            not u
            or not u["active"]
            or not await asyncio.to_thread(ac.password_ok, body.get("password"), u["password"])
        ):
            raise HTTPException(401, "Invalid login or password, or access suspended.")
        return login_response(u, request)

    @app.post("/api/workspace/logout")
    async def logout(request: Request):
        db._exec(
            "DELETE FROM account_logins WHERE hash=?",
            (ac.digest(request.cookies.get(ac.COOKIE, "")),),
        )
        response = JSONResponse({"ok": True})
        response.delete_cookie(ac.COOKIE)
        return response

    @app.get("/api/workspace/me")
    async def me(request: Request):
        return ac.public(ac.current(request))

    @app.post("/api/workspace/account")
    async def update_account(request: Request):
        u = ac.current(request)
        body = await read_json(request)
        if not await asyncio.to_thread(ac.password_ok, body.get("current_password"), u["password"]):
            raise HTTPException(403, "Current password is incorrect.")
        hashed = await asyncio.to_thread(ac.password_hash, body.get("password"))
        db._exec(
            "UPDATE users SET name=?,subject=?,password=? WHERE id=?",
            (text(body, "name"), text(body, "subject"), hashed, u["id"]),
        )
        ac.revoke_all(u["id"])
        ac.audit(u["id"], "profile_password_changed", u["id"])
        return login_response(ac.user(u["id"]), request)

    @app.post("/api/workspace/activate")
    async def activate(request: Request):
        limited(request)
        body = await read_json(request)
        token_hash = ac.digest(text(body, "token", 256))
        hashed = await asyncio.to_thread(ac.password_hash, body.get("password"))
        with db._lock, db._conn:
            row = db._conn.execute(
                "SELECT * FROM account_tokens WHERE hash=? AND used=0 AND expires>?",
                (token_hash, int(time.time())),
            ).fetchone()
            if not row:
                raise HTTPException(
                    400, "Invitation/recovery link is expired, cancelled or already used."
                )
            if row["kind"] == "invite":
                uid = secrets.token_hex(12)
                if db._conn.execute(
                    "SELECT 1 FROM users WHERE email=?", (row["email"],)
                ).fetchone():
                    raise HTTPException(409, "Email already registered. Request password recovery.")
                db._conn.execute(
                    "INSERT INTO users(id,email,name,subject,password,role,sections) VALUES(?,?,?,?,?,'teacher',?)",
                    (
                        uid,
                        row["email"],
                        text(body, "name"),
                        text(body, "subject"),
                        hashed,
                        row["sections"],
                    ),
                )
            else:
                uid = row["user_id"]
                existing = db._conn.execute(
                    "SELECT active FROM users WHERE id=?", (uid,)
                ).fetchone()
                if not existing or not existing["active"]:
                    raise HTTPException(403, "Account is suspended.")
                db._conn.execute("UPDATE users SET password=? WHERE id=?", (hashed, uid))
                db._conn.execute("DELETE FROM account_logins WHERE user_id=?", (uid,))
                db._conn.execute("UPDATE developer_keys SET revoked=1 WHERE owner_id=?", (uid,))
            db._conn.execute("UPDATE account_tokens SET used=1 WHERE hash=?", (token_hash,))
        ac.audit(uid, "account_activated_or_recovered", uid)
        return login_response(ac.user(uid), request)

    @app.get("/api/workspace/catalog")
    async def get_catalog(request: Request):
        u = ac.current(request)
        tasks = await asyncio.to_thread(ac.catalog_tasks, u)
        return {
            "sections": {s: catalog.SECTIONS[s] for s in ac.sections(u)},
            "tasks": [
                {
                    "id": t["id"],
                    "title": t["title"],
                    "prompt": t["prompt"],
                    "type": t["type"],
                    "level": t.get("level", 1),
                    "section": catalog.section_for(t),
                    "set": catalog.set_for(t),
                    "setName": t.get("setName")
                    or catalog.set_label(catalog.set_for(t), catalog.section_for(t)),
                }
                for t in tasks
            ],
        }

    @app.post("/api/workspace/import")
    async def import_bank(request: Request):
        u = ac.current(request)
        body = await read_json(request)
        title = text(body, "title")
        tasks = await asyncio.to_thread(validate_tasks, body.get("tasks"))
        section = body.get("section")
        if section not in ac.sections(u):
            raise HTTPException(403, "Subject access required.")
        if body.get("mode") not in ("once", "permanent"):
            raise HTTPException(400, "Choose once or permanent.")
        set_id = "personal-" + secrets.token_hex(12)
        for i, t in enumerate(tasks):
            t.update(id=f"{set_id}-{i}", section=section, block=set_id, setName=title)
        if body["mode"] == "permanent":
            db._exec(
                "INSERT INTO teacher_sets(id,owner_id,section,title,tasks) VALUES(?,?,?,?,?)",
                (set_id, u["id"], section, title, json.dumps(tasks, ensure_ascii=False)),
            )
            ac.audit(u["id"], "set_saved", set_id)
            return {"set_id": set_id, "count": len(tasks)}
        g = new_room(u)
        key = secrets.token_urlsafe(24)
        g.pending_imports[key] = {"tasks": tasks, "title": title, "created": time.time()}
        g.save_snapshot()
        return {"room": g.room_id, "import_id": key, "count": len(tasks)}

    @app.get("/api/workspace/rooms")
    async def get_rooms(request: Request):
        u = ac.current(request)
        return [
            {
                "id": k,
                "status": g.session["status"],
                "participants": len(g.by_nick),
                "title": g.session.get("title")
                or g.session.get("metadata", {}).get("title", "Prepared session"),
                "owner_id": g.owner_id,
            }
            for k, g in rooms.items()
            if g.owner_id == u["id"] or u["role"] == "admin"
        ]

    @app.post("/api/workspace/rooms")
    async def create_room(request: Request):
        u = ac.current(request)
        g = new_room(u)
        return {"id": g.room_id}

    @app.post("/api/workspace/rooms/{rid}/close")
    async def close_room(rid: str, request: Request):
        u = ac.current(request)
        g = room_for(u, rid)
        async with g.lock:
            if g.session["status"] == "running":
                raise HTTPException(409, "Finish the session before closing its room.")
            for ws in list(g.students) + list(g.teachers):
                await ws.close(code=1000)
            g._cancel_timers()
            db._exec("DELETE FROM room_owners WHERE room=?", (rid,))
            rooms.pop(rid, None)
            g.snapshot_file.unlink(missing_ok=True)
        return {"ok": True}

    @app.post("/api/workspace/rooms/{rid}/settings")
    async def settings(rid: str, request: Request):
        u = ac.current(request)
        if u["suspend_after"]:
            raise HTTPException(403, "Account access ends after the current class.")
        g = room_for(u, rid)
        body = await read_json(request)
        async with g.lock:
            if g.session["status"] != "lobby":
                raise HTTPException(409, "Session has already started.")
            g.session["title"] = text(body, "title")
            ids = body.get("taskIds", [])
            permitted = {t["id"] for t in ac.catalog_tasks(u)}
            if (
                not isinstance(ids, list)
                or len(ids) > 500
                or not all(isinstance(i, str) and i in permitted for i in ids)
            ):
                raise HTTPException(400, "Choose questions from your permitted library.")
            import_id = body.get("importId")
            if import_id and import_id not in g.pending_imports:
                raise HTTPException(400, "One-session bank is unavailable.")
            stream = body.get("stream", 1)
            if type(stream) is not int or not 1 <= stream < 100000:
                raise HTTPException(400, "Group must be a number from 1 to 99999.")
            g.current_stream = stream
            g.session["preparation"] = {
                "title": g.session["title"],
                "taskIds": ids,
                "importId": import_id,
                "stream": stream,
            }
            g.session["reveal"] = body.get("reveal", "after")
            if g.session["reveal"] not in ("after", "immediate", "teacher"):
                raise HTTPException(400, "Invalid answer reveal setting.")
            if body.get("geo"):
                lat, lon, accuracy = coordinates(body["geo"])
                radius = body["geo"].get("radius")
                if (
                    type(radius) not in (int, float)
                    or not math.isfinite(radius)
                    or not 50 <= radius <= 5000
                ):
                    raise HTTPException(400, "Radius must be 50–5000 meters.")
                if accuracy > radius:
                    raise HTTPException(
                        400, "Teacher location is too imprecise. Retry or use a larger radius."
                    )
                g.session["geo"] = {
                    "latitude": lat,
                    "longitude": lon,
                    "accuracy": accuracy,
                    "radius": radius,
                }
            else:
                g.session.pop("geo", None)
            g.save_snapshot()
        return {"ok": True}

    @app.get("/api/workspace/sessions")
    async def history(request: Request):
        u = ac.current(request)

        def read():
            if u["role"] == "admin":
                rows = db.history_sessions(200)
            else:
                rows = db._all(
                    "SELECT s.* FROM sessions s JOIN session_owners o ON o.session_id=s.id WHERE o.owner_id=? ORDER BY s.id DESC LIMIT 200",
                    (u["id"],),
                )
            items = []
            for row in rows:
                try:
                    ac.own_session(u, row["id"])
                except HTTPException:
                    continue
                items.append(session_info(row, False))
            return items

        return await asyncio.to_thread(read)

    @app.get("/api/workspace/sessions/{sid}")
    async def report(sid: int, request: Request):
        u = ac.current(request)
        ac.own_session(u, sid)

        def read():
            row = db.history_session(sid)
            if not row:
                raise HTTPException(404, "Session not found.")
            meta = db.get_session_metadata(sid) or {}
            owner = db._all("SELECT room FROM session_owners WHERE session_id=?", (sid,))
            checks = (
                db._all(
                    "SELECT nick,status,distance,accuracy,reviewed_by FROM attendance_checks WHERE room=?",
                    (owner[0]["room"],),
                )
                if owner
                else []
            )
            return {
                "session": session_info(row),
                "questions": meta.get("snapshot", []),
                "answers": db._all(
                    "SELECT nick,task_id,correct,duration_ms,answer_text,points FROM answers WHERE session_id=? ORDER BY id",
                    (sid,),
                ),
                "results": db.history_records(sid, "results", 10000),
                "participants": db.history_records(sid, "attendance", 10000),
                "events": db.history_records(sid, "events", 10000),
                "checks": checks,
            }

        return await asyncio.to_thread(read)

    @app.post("/api/workspace/keys")
    async def create_key(request: Request):
        u = ac.current(request)
        body = await read_json(request)
        token = "ac_dev_" + secrets.token_urlsafe(32)
        kid = secrets.token_hex(12)
        now = int(time.time())
        db._exec(
            "INSERT INTO developer_keys(id,token_hash,name,created_at,expires_at,owner_id) VALUES(?,?,?,?,?,?)",
            (kid, ac.digest(token), text(body, "name", 80), now, now + 86400, u["id"]),
        )
        ac.audit(u["id"], "api_key_created", kid)
        return {"id": kid, "token": token, "expires_at": now + 86400}

    @app.get("/api/workspace/keys")
    async def keys(request: Request):
        u = ac.current(request)
        return db._all(
            "SELECT id,name,created_at,expires_at,revoked,owner_id FROM developer_keys WHERE owner_id=? ORDER BY created_at DESC",
            (u["id"],),
        )

    @app.post("/api/workspace/keys/{kid}/revoke")
    async def revoke(kid: str, request: Request):
        u = ac.current(request)
        rows = db._all("SELECT owner_id FROM developer_keys WHERE id=?", (kid,))
        if not rows or (u["role"] != "admin" and rows[0]["owner_id"] != u["id"]):
            raise HTTPException(404, "Key not found.")
        db.revoke_developer_key(kid)
        ac.audit(u["id"], "api_key_revoked", kid)
        return {"ok": True}

    @app.get("/api/workspace/requests")
    async def requests(request: Request):
        u = ac.current(request)
        return (
            db._all("SELECT * FROM teacher_requests ORDER BY id DESC LIMIT 200")
            if u["role"] == "admin"
            else db._all(
                "SELECT * FROM teacher_requests WHERE owner_id=? ORDER BY id DESC LIMIT 200",
                (u["id"],),
            )
        )

    @app.post("/api/workspace/requests")
    async def submit_request(request: Request):
        u = ac.current(request)
        body = await read_json(request)
        kind = body.get("kind")
        if kind not in ("feedback", "subject_access", "new_subject", "publish"):
            raise HTTPException(400, "Invalid request type.")
        if kind == "publish" and not db._all(
            "SELECT 1 FROM teacher_sets WHERE id=? AND owner_id=?", (body.get("title"), u["id"])
        ):
            raise HTTPException(400, "Choose one of your personal set IDs.")
        db._exec(
            "INSERT INTO teacher_requests(owner_id,kind,title,message,created) VALUES(?,?,?,?,?)",
            (u["id"], kind, text(body, "title"), text(body, "message", 4000), int(time.time())),
        )
        return {"ok": True}

    @app.get("/api/workspace/admin")
    async def admin(request: Request):
        ac.current(request, True)
        return {
            "users": [ac.public(ac.user(r["id"])) for r in db._all("SELECT id FROM users")],
            "invitations": db._all(
                "SELECT rowid AS id,email,kind,expires,used FROM account_tokens ORDER BY rowid DESC LIMIT 100"
            ),
            "audit": db._all("SELECT * FROM account_audit ORDER BY id DESC LIMIT 100"),
            "sets": db._all("SELECT id,owner_id,section,title,visibility FROM teacher_sets"),
            "keys": db._all(
                "SELECT id,name,owner_id,expires_at,revoked FROM developer_keys ORDER BY created_at DESC LIMIT 100"
            ),
        }

    @app.post("/api/workspace/admin/invite")
    async def invite(request: Request):
        u = ac.current(request, True)
        body = await read_json(request)
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        kind = body.get("kind", "invite")
        uid = body.get("user_id")
        if kind not in ("invite", "recover"):
            raise HTTPException(400, "Invalid invitation kind.")
        target = ac.user(uid) if kind == "recover" else None
        if kind == "recover" and (not target or not target["active"]):
            raise HTTPException(400, "Choose an active user.")
        address = target["email"] if target else email(body)
        permitted = target["sections"] if target else allowed_sections(body)
        if kind == "recover":
            db._exec("UPDATE account_tokens SET used=1 WHERE user_id=? AND kind='recover'", (uid,))
        db._exec(
            "INSERT INTO account_tokens(hash,user_id,email,kind,sections,expires) VALUES(?,?,?,?,?,?)",
            (
                ac.digest(token),
                uid,
                address,
                kind,
                json.dumps(permitted),
                now + (3600 if kind == "recover" else 172800),
            ),
        )
        ac.audit(u["id"], kind + "_issued", address)
        return {"token": token, "kind": kind, "expires_in": 3600 if kind == "recover" else 172800}

    @app.post("/api/workspace/admin/invitations/{iid}/cancel")
    async def cancel_invite(iid: int, request: Request):
        u = ac.current(request, True)
        db._exec("UPDATE account_tokens SET used=1 WHERE rowid=?", (iid,))
        ac.audit(u["id"], "invitation_cancelled", str(iid))
        return {"ok": True}

    @app.post("/api/workspace/admin/users/{uid}")
    async def update_user(uid: str, request: Request):
        actor = ac.current(request, True)
        target = ac.user(uid)
        if not target or target["role"] == "admin":
            raise HTTPException(400, "Owner account cannot be suspended here.")
        body = await read_json(request)
        if "sections" in body:
            db._exec(
                "UPDATE users SET sections=? WHERE id=?", (json.dumps(allowed_sections(body)), uid)
            )
        action = body.get("action")
        live = [g for g in rooms.values() if g.owner_id == uid and g.session["status"] == "running"]
        if action in ("suspend", "delete", "revoke"):
            if not (body.get("after_session") and live and action == "suspend"):
                ac.revoke_all(uid)
            if action != "revoke":
                if body.get("after_session") and live:
                    db._exec("UPDATE users SET suspend_after=1 WHERE id=?", (uid,))
                else:
                    db._exec("UPDATE users SET active=0,suspend_after=0 WHERE id=?", (uid,))
                    for g in live:
                        async with g.lock:
                            g._cancel_timers()
                            await g.finish_game()
                    if action == "delete":
                        db._exec(
                            "UPDATE teacher_sets SET owner_id=?,visibility='personal' WHERE owner_id=?",
                            (actor["id"], uid),
                        )
                        # Tombstone preserves attribution and prevents re-registration collisions.
                        db._exec("UPDATE users SET name=name || ' [removed]' WHERE id=?", (uid,))
        if action == "activate":
            db._exec("UPDATE users SET active=1,suspend_after=0 WHERE id=?", (uid,))
        for g in list(rooms.values()):
            if g.owner_id == uid and not (
                body.get("after_session") and live and action == "suspend"
            ):
                for ws in list(g.teachers):
                    await ws.close(code=1008)
        ac.audit(actor["id"], action or "permissions_updated", uid)
        return {"ok": True}

    @app.post("/api/workspace/admin/requests/{iid}")
    async def resolve(iid: int, request: Request):
        u = ac.current(request, True)
        body = await read_json(request)
        status = body.get("status")
        if status not in ("approved", "declined", "needs_information", "resolved"):
            raise HTTPException(400, "Invalid request status.")
        rows = db._all("SELECT * FROM teacher_requests WHERE id=?", (iid,))
        if not rows:
            raise HTTPException(404, "Request not found.")
        r = rows[0]
        if status == "approved" and r["kind"] == "subject_access":
            target = ac.user(r["owner_id"])
            if r["title"] not in catalog.SECTIONS:
                raise HTTPException(
                    400, "Request title must be a section ID: algorithms, oop, graphs, db or nn."
                )
            db._exec(
                "UPDATE users SET sections=? WHERE id=?",
                (json.dumps(sorted(set(target["sections"] + [r["title"]]))), target["id"]),
            )
        if status == "approved" and r["kind"] == "publish":
            db._exec(
                "UPDATE teacher_sets SET visibility='shared' WHERE id=? AND owner_id=?",
                (r["title"], r["owner_id"]),
            )
        db._exec(
            "UPDATE teacher_requests SET status=?,reply=? WHERE id=?",
            (status, str(body.get("reply", ""))[:4000], iid),
        )
        ac.audit(u["id"], "request_" + status, str(iid))
        return {"ok": True}

    @app.post("/api/workspace/rooms/{rid}/attendance")
    async def manual_attendance(rid: str, request: Request):
        u = ac.current(request)
        g = room_for(u, rid)
        body = await read_json(request)
        nick = body.get("nick")
        if nick not in g.by_nick or body.get("status") not in (
            "confirmed",
            "rejected",
            "needs_review",
        ):
            raise HTTPException(400, "Choose a participant and attendance status.")
        db._exec(
            "INSERT INTO attendance_checks(room,nick,status,reviewed_by,at) VALUES(?,?,?,?,?) ON CONFLICT(room,nick) DO UPDATE SET status=excluded.status,reviewed_by=excluded.reviewed_by,at=excluded.at",
            (rid, nick, body["status"], u["id"], int(time.time())),
        )
        g.mark_teacher_dirty()
        return {"ok": True}

    @app.get("/api/attendance/{rid}")
    async def attendance_options(rid: str):
        g = rooms.get(rid)
        if not g:
            raise HTTPException(404, "Room not found.")
        return {"enabled": bool(g.session.get("geo"))}

    @app.post("/api/attendance/{rid}")
    async def check_attendance(rid: str, request: Request):
        body = await read_json(request)
        g = rooms.get(rid)
        s = g.find_participant(str(body.get("nick", ""))) if g else None
        if not s or not secrets.compare_digest(str(body.get("resume", "")), s.get("resume", "!")):
            raise HTTPException(403, "Join the session first.")
        checks = db._all(
            "SELECT status,at FROM attendance_checks WHERE room=? AND nick=?", (rid, s["nick"])
        )
        if checks and checks[0]["status"] in ("confirmed", "rejected"):
            return {"status": checks[0]["status"]}
        if checks and int(time.time()) - checks[0]["at"] < 10:
            return {"status": checks[0]["status"]}
        if g.session["status"] == "finished":
            raise HTTPException(
                409, "Location confirmation is closed. Ask the teacher for manual review."
            )
        geo = g.session.get("geo")
        if not geo:
            return {"status": "not_required"}
        if body.get("unavailable"):
            status, d, accuracy = "needs_review", None, None
        else:
            lat, lon, accuracy = coordinates(body)
            timestamp = body.get("timestamp")
            if (
                type(timestamp) not in (int, float)
                or not math.isfinite(timestamp)
                or abs(time.time() * 1000 - timestamp) > 120000
            ):
                raise HTTPException(400, "Location is stale. Request a fresh reading.")
            d = distance((lat, lon), (geo["latitude"], geo["longitude"]))
            status = geo_status(d, geo["radius"], accuracy + geo["accuracy"])
        db._exec(
            "INSERT INTO attendance_checks(room,nick,status,distance,accuracy,at) VALUES(?,?,?,?,?,?) ON CONFLICT(room,nick) DO UPDATE SET status=excluded.status,distance=excluded.distance,accuracy=excluded.accuracy,at=excluded.at",
            (rid, s["nick"], status, d, accuracy, int(time.time())),
        )
        g.mark_teacher_dirty()
        return {
            "status": status,
            "distance": round(d) if d is not None else None,
            "accuracy": accuracy,
        }
