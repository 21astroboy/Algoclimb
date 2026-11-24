# Agent handbook

This directory is the handoff package for agents working on AlgoClimb. It explains the system,
its classroom workflows and its operational constraints. It contains no credentials or student records.
Start with the repository [AGENTS.md](../AGENTS.md), then choose the guides below.

| Task | Read before editing | Main implementation |
| --- | --- | --- |
| Gameplay, timers, scores, reconnect | architecture, product, testing | `backend/main.py`, `backend/bank.py`, `backend/validation.py` |
| Teacher accounts, sharing, API | architecture, product | `backend/accounts.py`, `backend/workspace.py`, `backend/developer_api.py` |
| Teacher UI | frontend, product, testing | `frontend/workspace.js`, `frontend/workspace.css` |
| Student UI and connection recovery | frontend, architecture, testing | `frontend/student.html`, `frontend/attendance.js` |
| JSON bank import | product, architecture | `backend/import_bank.py`, `backend/catalog.py` |
| Storage changes | architecture, operations | `backend/db.py`, `backend/accounts.py` |
| Deployment or production incident | operations, testing | `docker-compose.yml`, `Dockerfile`, `tools/` |
| Documentation | product, frontend | `README.md`, `README.ru.md`, `docs/teacher-guide*` |

## Context and intent

AlgoClimb is a self-hosted live classroom quiz. The teacher prepares a room, students join from phones,
and the teacher starts the quiz. Correct answers move students toward the summit. Attendance checks
help the teacher decide whom to grade but do not rewrite quiz scores. Teachers also review saved reports.
The system must handle intermittent classroom Wi-Fi and bursts of answers without losing identities.

Primary users:
- Administrator: issues invitations and recovery links, manages teachers, permissions and shared content.
- Teacher: prepares rooms, imports questions, runs classes, reads owned/shared reports and issues read-only API keys.
- Student: joins a room, answers questions and reconnects with the same identity and saved progress.
- External developer: reads permitted results through a short-lived bearer API key.

## How to start a task

1. Read the user's current scope and the applicable guide. Inspect Git status before edits.
2. Trace the full flow: visible control → HTTP/WS message → authorization → state mutation → persisted data → UI refresh.
3. Identify compatibility constraints: existing SQLite rows, old snapshots, private banks and stale browser assets.
4. Implement the smallest complete change. Prefer existing native JavaScript/Python patterns over new frameworks.
5. Test both the success path and the relevant boundary: permissions, malformed input, reconnect or small screen.
6. Update the user guide and these guides if the architecture or workflow changes.
7. Publish/deploy only within the user's authorization. Report what passed and anything not verified.

## Other documentation

- [English teacher guide](../docs/teacher-guide.md), [Russian teacher guide](../docs/teacher-guide.ru.md)
- [Workspace internals](../docs/workspace.md), [Russian workspace internals](../docs/workspace.ru.md)
- [Question formats](../docs/task-bank.md), [Russian question formats](../docs/task-bank.ru.md)
- [Reliability](../docs/reliability.md), [development](../docs/development.md), [deployment](../docs/deployment.md)

The guides are checked-in documentation, not a live inventory. Re-check container names, branch heads,
permissions and active rooms before operational changes. Do not infer production secrets from examples.
