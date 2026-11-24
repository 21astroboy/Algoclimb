# Testing and diagnostics

## Safe setup

Use Python 3.11+ (CI uses 3.12) and Node 22+. Install Python dependencies from `requirements.txt`,
plus the versions of Ruff/mypy/httpx specified in `.github/workflows/ci.yml`. Run `npm ci` for JS tooling.
All application tests must use a temporary `RUNTIME_DIR`. Some modules initialize SQLite on import.
Set the environment before importing `main`, `db` or `accounts`; changing it later is too late.

Never run account/room creation fixtures against the VPS. Browser tests using route mocks are safe;
HTTP/WebSocket E2E should launch an isolated loopback server with a public fixture bank.
The local `.venv` may be older than the documented supported runtime; do not lower production support
or add unrelated compatibility patches merely to work around a local interpreter limitation.

## Main commands

From the repository root, with the environment activated:

```bash
npm run lint
ruff check backend
ruff format --check backend
mypy
```

Run backend tests with an absolute temporary runtime path:

```bash
runtime=$(mktemp -d)
(cd backend && RUNTIME_DIR="$runtime" python -m unittest \
  test_timers test_answers test_teacher_updates test_connection_recovery test_import_bank test_workspace)
(cd backend && python -m e2e_test)
python -m unittest tools.test_reliability
node --test tools/test_connection.cjs
```

The E2E runner creates its own isolated application/runtime. Read a tool before invoking it; options
for a live target may change the safety assumptions. The CI workflow is the authoritative complete list.
Do not use a broad auto-fix over unrelated notebooks or the user's research directory.

Install Chromium for browser fixtures:

```bash
npx playwright install chromium
node tools/check_session_timing.cjs
node tools/check_workspace_ux.cjs
node tools/check_climb_board.cjs
```

On macOS, a local browser can be selected without downloading another one:

```bash
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node tools/check_workspace_ux.cjs
```

Some tests need a local demo server; follow the relevant workflow step or `docs/development.md`.
`tools/check_accounts.cjs` expects an isolated account server, not the public production site.

## Test responsibilities

- `test_timers`: timer replacement/cancellation, phase transitions and timing recovery.
- `test_answers`: malformed/late/paused answers, grading boundaries and one-attempt rules.
- `test_connection_recovery`: recovery secrets, disconnect grace, dead socket handling and tab-leave batching.
- `test_teacher_updates`: reconnect/answer bursts remain cheap; detailed history is sent at finish.
- `test_import_bank`: uploaded bank validity and supported task formats.
- `test_workspace`: account/room/report isolation, invitations/recovery, attendance, settings and sharing.
- `test_connection.cjs`: student connection code under deterministic silent/open/closed socket failures.
- `check_session_timing.cjs`: optional fields, validation, persisted settings payload and mobile layout.
- `check_workspace_ux.cjs`: button states, logo/back, nested report navigation, tab counters and session dialog.
- `check_climb_board.cjs`: realistic large rosters, checkpoint distribution, long names, filtering and scrolling.

For telemetry changes, check both browser event eligibility and server persistence. A counter in a live
payload alone does not prove a saved report receives the event. Include an unknown/kicked identity boundary.
For authorization changes, test another teacher and current permission revocation, not just an administrator.
For timer changes, compare actual deadline, outgoing `limit`, resume behavior and speed bonus denominator.

## Reliability measurements

Use `tools/reliability_test.py`, `tools/loadtest.py` and `docs/reliability.md` for load/reconnect evidence.
Run benchmarks on an isolated candidate first. Record student count, rounds, disconnect scenarios,
latency distributions and unexpected disconnects; do not infer reliability from CPU usage alone.
Do not run a synthetic class against production during a real lecture without explicit scope/coordination.
A `disconnect` event establishes an observation, not a browser/network root cause.

## Completion evidence

Report the focused tests, CI result, deployed commit and production health when relevant. Distinguish:
- source syntax/lint success;
- mocked UI correctness;
- isolated HTTP/WS E2E;
- live deployment health;
- measured load reliability.

These are complementary, not interchangeable. Never claim 120 real phones were tested when the run
used synthetic sockets. If a required check fails, resolve it or describe the remaining limitation.
