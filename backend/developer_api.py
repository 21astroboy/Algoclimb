"""Teacher-authorized temporary imports and expiring read-only history access."""

import asyncio
import hashlib
import json
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse

import bank
import catalog
import db
from import_bank import validate_tasks

MAX_BODY = 2 * 1024 * 1024


async def read_json(request):
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_BODY:
            raise HTTPException(413, "JSON file must be no larger than 2 MiB.")
    try:
        value = json.loads(body)
    except (ValueError, RecursionError) as exc:
        raise HTTPException(400, "Invalid JSON.") from exc
    return value


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def session_info(row, include_questions=True):
    sid = row["id"]
    saved = db.get_session_metadata(sid)
    if saved is None:
        ids = db.history_task_ids(sid)
        tasks = [bank.BY_ID[i] for i in ids if i in bank.BY_ID]
        saved = catalog.metadata(tasks, source="legacy")
        saved["provenance"] = "inferred_from_answered_questions" if ids else "unavailable"
        saved["title"] = saved["title"] if tasks else None
        saved["unresolved_question_ids"] = [i for i in ids if i not in bank.BY_ID]
        saved["question_count"] = len(ids)
    saved.setdefault("question_count", len(saved["questions"]))
    if not include_questions:
        saved.pop("questions", None)
    winners = db.history_records(sid, "results", 1)
    winner = winners[0] if winners and winners[0]["place"] == 1 else None
    return {**row, **saved, "winner": winner}


def register(app, game, teacher_key):
    def require_teacher(request):
        candidate = request.headers.get("X-Teacher-Key", "")
        if not secrets.compare_digest(candidate.encode(), teacher_key.encode()):
            raise HTTPException(401, "Invalid teacher key.")

    async def require_api(request):
        auth = request.headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else ""
        digest = hashlib.sha256(token.encode()).hexdigest()
        if not token or not await asyncio.to_thread(
            db.developer_key_valid, digest, int(time.time())
        ):
            raise HTTPException(
                401,
                "API key is invalid, expired or revoked.",
                headers={"WWW-Authenticate": "Bearer"},
            )

    @app.get("/developers", response_class=HTMLResponse, include_in_schema=False)
    async def portal():
        return HTMLResponse(
            (Path(__file__).resolve().parent.parent / "frontend/developers.html").read_text(),
            headers={"Cache-Control": "no-store"},
        )

    @app.post("/api/v1/auth/token", tags=["Developer API"])
    async def issue(request: Request):
        require_teacher(request)
        payload = await read_json(request)
        name = payload.get("name", "Developer integration") if isinstance(payload, dict) else ""
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
            raise HTTPException(400, "Provide a key name of 1 to 80 characters.")
        token = "ac_dev_" + secrets.token_urlsafe(32)
        key_id = secrets.token_hex(12)
        created = int(time.time())
        expires = created + 86400
        await asyncio.to_thread(
            db.create_developer_key,
            key_id,
            hashlib.sha256(token.encode()).hexdigest(),
            name.strip(),
            created,
            expires,
        )
        return JSONResponse(
            {
                "id": key_id,
                "access_token": token,
                "token_type": "Bearer",
                "expires_at": iso(expires),
                "expires_in": 86400,
                "scope": "sessions:read results:read",
            },
            headers={"Cache-Control": "no-store"},
        )

    @app.post("/api/v1/auth/token/{key_id}/revoke", tags=["Developer API"])
    async def revoke(key_id: str, request: Request):
        require_teacher(request)
        if not await asyncio.to_thread(db.revoke_developer_key, key_id):
            raise HTTPException(404, "API key not found.")
        return {"revoked": True}

    @app.get("/api/v1/sessions", tags=["Developer API"])
    async def sessions(
        request: Request, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0)
    ):
        await require_api(request)
        rows = await asyncio.to_thread(db.history_sessions, limit, offset)
        items = await asyncio.to_thread(
            lambda: [session_info(row, include_questions=False) for row in rows]
        )
        return JSONResponse(
            {"items": items, "limit": limit, "offset": offset},
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/api/v1/sessions/{session_id}", tags=["Developer API"])
    async def session(session_id: int, request: Request):
        await require_api(request)
        row = await asyncio.to_thread(db.history_session, session_id)
        if row is None:
            raise HTTPException(404, "Session not found.")
        return JSONResponse(
            await asyncio.to_thread(session_info, row), headers={"Cache-Control": "no-store"}
        )

    @app.get("/api/v1/sessions/{session_id}/{kind}", tags=["Developer API"])
    async def records(
        session_id: int,
        kind: str,
        request: Request,
        limit: int = Query(100, ge=1, le=500),
        offset: int = Query(0, ge=0),
    ):
        await require_api(request)
        if kind not in ("results", "answers", "attendance", "events"):
            raise HTTPException(404, "Unknown record type.")
        if await asyncio.to_thread(db.history_session, session_id) is None:
            raise HTTPException(404, "Session not found.")
        items = await asyncio.to_thread(db.history_records, session_id, kind, limit, offset)
        return JSONResponse(
            {"session_id": session_id, "items": items, "limit": limit, "offset": offset},
            headers={"Cache-Control": "no-store"},
        )

    @app.post("/api/teacher/imports", tags=["Teacher"])
    async def import_questions(request: Request):
        require_teacher(request)
        payload = await read_json(request)
        if not isinstance(payload, dict):
            raise HTTPException(400, "Provide title and tasks.")
        title = payload.get("title")
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 160:
            raise HTTPException(400, "Provide a session title of 1 to 160 characters.")
        try:
            tasks = await asyncio.to_thread(validate_tasks, payload.get("tasks"))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        async with game.lock:
            if game.session["status"] != "lobby":
                raise HTTPException(409, "Import questions in the lobby before starting a session.")
            now = time.time()
            game.pending_imports = {
                k: v for k, v in game.pending_imports.items() if now - v["created"] < 3600
            }
            if len(game.pending_imports) >= 20:
                raise HTTPException(
                    429, "Too many pending banks. Try again after unused imports expire."
                )
            key = secrets.token_urlsafe(24)
            game.pending_imports[key] = {"tasks": tasks, "title": title.strip(), "created": now}
        return {
            "import_id": key,
            "title": title.strip(),
            "count": len(tasks),
            "questions": [{"id": t["id"], "title": t["title"], "type": t["type"]} for t in tasks],
        }
