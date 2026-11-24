# Architecture and persistence

## Runtime model

- FastAPI runs in one Uvicorn process with the `wsproto` WebSocket implementation.
- `backend/main.py` owns `Game`, the room registry, server lifecycle and public HTTP/WS routes.
- A `Game` owns one room's lock, roster, sockets, question order, round state, deadlines and timers.
- The registry includes an empty-ID legacy service game. It is not a prepared teacher room and must not
  appear in the personal room list. Real room IDs are non-empty; do not generate `/rooms//close` URLs.
- Multiple teachers may run independent rooms in the same process. Never use global settings for a room override.
- Async locks serialize changes within a room. Avoid blocking file/network/CPU work inside these locks.
- The teacher state uses batched dirty updates rather than rebuilding the full classroom state for every answer.
- During live rounds, detailed per-answer arrays are omitted from the teacher payload; final state includes them.

## Module map

| Module | Responsibility |
| --- | --- |
| `main.py` | Game lifecycle, WebSockets, grading orchestration, timing, snapshot recovery, static HTTP routes |
| `bank.py` | Load questions, parameterize tasks, public projections, type-specific checks and answer descriptions |
| `validation.py` | Validate submitted answer shapes before spending an attempt |
| `catalog.py` | Subject/set classification, set labels and session metadata |
| `import_bank.py` | Validate uploaded question banks and strip/normalize unsupported input |
| `workspace.py` | Account workspace HTTP endpoints, room configuration, reports, admin actions, attendance |
| `accounts.py` | Users, cookies, credentials, access checks, catalog visibility and account tables |
| `developer_api.py` | Expiring read-only developer keys and permitted session/result endpoints |
| `db.py` | SQLite schema, answers, results, attendance, events and session metadata |
| `security.py` | Join code rotation, nonce/security helpers |
| `analytics.py`, `gsheets.py` | Existing exports and optional Google Sheets integration |

## Request flow

Teacher workspace loads identity/catalog/history using `/api/workspace/*`. A classroom opens a teacher
WebSocket at `/teacher?room=<id>` using the account cookie. Student sockets join the selected classroom
through the student page. The public student join path must not expose answers, teacher credentials or raw
private task specs. A client-supplied nickname or room ID is never sufficient authorization for recovery.

Server grading flow:
1. Resolve the joined student and reject kicked/unknown identities.
2. Check the session phase, task ID, duplicate attempt, pause state and deadline.
3. Validate the payload shape. Invalid payloads do not spend the attempt.
4. Translate shuffled choice indices, run the type checker and compute points.
5. Persist the answer, update score/streak/progress, acknowledge the student and mark teacher state dirty.
6. End/advance the round through the existing timeout, all-answered and reconnect-grace rules.

## Timing invariant

`Game.time_limit_for(task)` is the single effective duration used by live deadlines, student and teacher
payloads, resume messages and speed scoring. Session `timeLimits` takes precedence over task `timeLimit`.
Task `timeLimit` takes precedence over platform defaults. Units: JSON/UI overrides are seconds; deadlines,
wire `limit` and internal timer delays are milliseconds. Do not confuse them.

`timeLimits` accepts only `choice`, `graph`, `order`, `sort`, `blank`, with integer values 5–3600.
Missing types retain existing behavior. The room settings endpoint allows changes only in the lobby.
Configuration is stored inside the session and preparation, survives snapshots and is copied to report metadata.
The teacher's existing +15 seconds control extends the current deadline without rewriting the bank.

## Persistence layers

- `RUNTIME_DIR` selects runtime storage. Default: `backend/data/runtime`.
- `algoclimb.db` stores session history, answers, result rankings, events, attendance and account-related data.
- Session metadata stores question snapshots with correct-answer descriptions for later reports.
- `room-<id>.json` stores each live room state; `session-state.json` is the legacy default game snapshot.
- Snapshots contain roster, answers, question order, deadline, phase, pause state and session settings.
- Snapshot writes use temporary-file replacement and skip unchanged states. Keep them serializable.
- After recovery, connected participants are initially treated as disconnected; reconnect grace avoids ending
  the round as soon as only one phone returns. Recreate timer tasks using the saved deadline.
- A restart must preserve runtime volumes and the private bank mount. Closing a room must preserve reports.

Account and history tables are created/migrated through the existing initialization functions.
Use additive, backwards-compatible migrations. Do not wipe a database to solve schema incompatibility.
Old sessions may lack question snapshots or detailed answers; display the explicit legacy state.

## Static frontend and assets

There is no frontend bundler. HTML, CSS and JS are served from `frontend/`. The teacher workspace is the
main account UI; `teacher.html` is a legacy interface, and `/teacher` routing depends on account setup.
Static reads use the deployed files. Version the workspace script/style URLs when behavior changes so
cached browsers fetch the matching pair. Keep shared `site-footer.js` and `interactions.css` available.

## Configuration and secrets

Read `.env.example` and `backend/config/config.example.json` for public defaults. Environment can override
public URL, binding, trusted proxy IPs, private bank paths, debug/docs, QR rotation and Sheets integration.
`TASK_BANK_PATH` and `EXPLANATIONS_PATH` normally point to the private read-only mount in Docker.
Private banks must not be copied into the Git repository or image. `.dockerignore` excludes local artifacts.
Never dump all environment values, runtime JSON, database rows or application startup logs into a report;
some contain bootstrap keys or participant identities. Query only the fields needed for diagnostics.
