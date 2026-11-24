# Product rules and access boundaries

## Teacher lifecycle

1. An administrator grants subject access and issues a single-use invitation.
2. The teacher opens the invitation, enters their name/subject and chooses a password.
3. Normal access uses the personal account, not the legacy shared teacher key.
4. Without SMTP, invitations and recovery links are distributed manually by the administrator.
5. Recovery/password changes invalidate relevant credentials through the existing account code.

Do not require SMTP or an open port 25 for this product. Account authorization, expiry and suspension
are server checks, not UI conventions. The administrator's production login is managed by the owner;
never reset their password or copy an initial credential file as a routine task.

## Permissions

- Administrator manages users, subject grants, suspensions, API credentials and publication requests.
- A teacher owns their rooms/sessions, personal sets and API keys.
- Teachers see only permitted subjects and owned/explicitly shared reports.
- Shared session access is read-only and still subject to current subject permissions.
- Sharing a report does not transfer ownership or room controls.
- API keys expire after 24 hours and permit reading sessions/results, not control of a classroom.
- Revoked, expired or suspended access must fail at the endpoint/WS boundary.
- Keep API responses free of passwords, raw credentials, student resume secrets and unnecessary private data.

Check `accounts.py` and workspace/developer API handlers for the exact current authorization path.
When adding an endpoint, test another teacher's request, not just the owner/admin happy path.

## Subjects and question banks

Subjects: Algorithms, OOP, Graphs, DB, NN. Graphs includes the existing combinatorics sets; `comb1`
intentionally stays wholly in Graphs even though its contents include algorithm basics.
DB/NN can be empty until questions are supplied. Do not fabricate a bank or silently move existing sets.
Navigation is Subject → Question set → Questions. The old Topics filter is intentionally removed.

Question types:
- `choice`: choose an option; the public option order can be shuffled.
- `graph`: build a graph matching the task's checker.
- `order`: submit a traversal/order sequence.
- `sort`: submit a sorting result/trace according to the question definition.
- `blank`: fill placeholders in a template.

Use the full schema/examples in `docs/task-bank.md`; this overview is not a substitute for validation.
Tasks can have their own `timeLimit` in seconds. Preserve task-specific overrides during parameterization.

Import modes:
- One session: a separate temporary bank, not mixed into the permanent bank. It is consumed on start and can expire.
- Permanent: save as the teacher's personal set in an authorized subject.
- Publication: shared-bank changes require administrator review, rather than automatic global publication.

## Room and session lifecycle

A prepared room begins in `lobby`. Students join before the teacher starts the quiz. Running status has
current round, pause/intermission/deadline and submitted-answer state. Finished status preserves results.
Closing a non-running room removes the live room, sockets and snapshot but does not delete saved reports.
A running room must be finished before closing. Never add a silent force-delete of an active class.
The current implementation limits unfinished rooms per teacher; inspect `new_room` for the current bound.

The session preparation form contains title/group, answer feedback policy, optional timing and attendance.
`after`, `immediate`, `teacher` control when correctness is revealed. Do not leak answers before the
selected policy allows them. Correct answers can be shown to teachers, never in public student payloads.

## Student identity and recovery

Reconnection preserves the same student's answers and points. A nickname alone cannot steal an identity.
The student's resume secret is private to that browser/socket and is not included in the teacher roster.
Join-code rotation applies to fresh admissions; it must not break an already admitted student's recovery.
Connection health, stale socket cleanup and deadman timeouts are separate from quiz correctness.
A single participant's disconnect should not immediately finish the round for the whole class.

## Attendance and grading

Location attendance is optional. It compares the student's browser position/accuracy with the teacher's
position and selected radius; it is not an IP location check. HTTPS and browser permission are required.
Uncertain positions need manual review. Do not automatically treat permission denial, poor GPS or an
ordinary VPN as cheating. Do not continuously poll/store raw student coordinates.

Keep quiz ranking and attendance eligibility separate. The teacher may manually confirm presence and
review the top 10 before awarding grades. Attendance-filtered CSV is distinct from all-participant results.

## Tab-leave telemetry

The student page listens to `visibilitychange`. It sends `tableave` when the document becomes hidden,
a student has joined, the question screen is visible, the session has not finished and the socket is open.
The backend increments the live counter and persists a timestamped event for ordinary non-practice sessions.
Teacher notifications remain batched; do not broadcast full histories for each event.

The workspace displays live counts, leaderboard/student-matrix counts, individual report metrics and
human-readable events under Connections. Historical counts are derived from stored `tableave` events.
Practice sessions do not create normal persisted history. Old sessions may not have these records.
This is best-effort telemetry: disconnected exits or pages already killed by the OS cannot reliably report.
It does not measure absence duration and is not proof of misconduct. Avoid claiming otherwise in the UI.

## Reports

Report tabs are real sections: Overview, Leaderboard, Students, Questions, Connections.
A student detail shows every stored answer beside its correct answer and correctness/score/timing.
A question detail compares all student submissions for that question.
Preserve full names, support many columns/students through scroll, and show legacy gaps explicitly.
No analytics task should alter historic results just to make an empty chart look complete.
