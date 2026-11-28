# Repository layout audit · 28 November 2026

The tracked runtime code already follows the intended split. No code relocation was necessary.

| Location | Responsibility | Notes |
| --- | --- | --- |
| `backend/` | FastAPI, WebSockets, game rules, auth, SQLite, import and API | Python runtime modules and backend regression tests |
| `backend/config/` | Public example configuration | Real config may be mounted/excluded from Git |
| `frontend/` | Browser HTML, JavaScript, CSS and static vendor files | No server logic or private question bank |
| `frontend/locales/` | Interface translation dictionaries | Russian workspace messages; question content remains unchanged |
| `tools/` | Development, demo, browser checks, screenshots and load tools | Not application runtime; excluded from the Docker image |
| `docs/` | User/developer documentation, benchmarks and synthetic screenshots | Includes the mirrored backlog specifications |
| `agents/`, `AGENTS.md` | Agent handoff and repository working rules | Documentation only |
| `.github/workflows/` | CI | Runs backend, frontend and Docker checks |
| Root manifests | Docker/Compose, requirements, package files, lint config | Standard project-wide entry points; kept at the root |
| Root `algoclimb` | Operator command-line entry point | Kept at root for documented startup commands |

Runtime data (`backend/data/runtime`) and private `secrets/` mounts are excluded from Git/image packaging.
Existing untracked research archives, notebooks, `AB-test/` and design prototypes were not moved or modified.
The audit used the tracked-file inventory rather than treating unrelated local research as application code.
The static release changes no schema, authorization, quiz timing or WebSocket protocol.

See [architecture](../agents/architecture.md), [frontend conventions](../agents/frontend.md) and
[operations](../agents/operations.md) for boundaries and safe deployment instructions.
