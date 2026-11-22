# Developer API and one-session question banks

The teacher workspace groups questions into Algorithms, OOP, Graphs, DB and NN.
Each subject has its own sets. DB and NN appear with an empty state until questions
are supplied. Existing `oop*` sets map to OOP and `comb*` sets map to Graphs. The
original ungrouped bank maps to Algorithms, including its graph-algorithm exercises.
Set IDs and question IDs retain their values for historical matching.

An explicit `section` field on a question overrides this compatibility mapping.
Allowed values are `algorithms`, `oop`, `graphs`, `db` and `nn`. `block` names a set
within the section. Questions without a block appear under General questions.

## Try a bank for one session

1. Sign in to `/teacher` with the teacher key.
2. In the lobby choose **Upload JSON for one session** and select a JSON array in
   the format described in [Question banks](task-bank.md).
3. Check validation, question previews and the session name. The main library is
   hidden while an uploaded bank is selected. **Use the main library** cancels the
   selection in that browser.
4. Students join the same lobby. Start normally. Practice remains optional.
5. The import is consumed when the session starts. Upload again to run another
   session. Restarting before a session starts also requires a new upload.

A bank can contain 1–500 questions and must fit within 2 MiB. The validator checks
all five question types, unique IDs, references and answer formats before admission.
It checks sorting results and connected traversal/MST reference graphs. SVG figures
support a restricted set of drawing elements and reject scripts, event handlers,
external resources and inline styles.

Pending imports expire after one hour. They are separate from the permanent bank.
The running session's snapshot contains its selected questions for crash recovery.
Named metadata and results remain in history after a saved session finishes.
Practice sessions do not write database history. Unused drafts and API keys are
independent of the application's single shared live session.

## Create a 24-hour API key

Open `/developers`, enter the teacher key and choose a name for the integration.
Copy the displayed key and expiry time. The page also lets you load saved history,
inspect results/answers and revoke the newly created key.

For a script, issue a key with the teacher credential in a header.

```bash
curl -X POST "$BASE_URL/api/v1/auth/token" \
  -H "X-Teacher-Key: $TEACHER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Research integration"}'
```

The JSON response contains `access_token`, `token_type`, `expires_in: 86400`, an
absolute UTC `expires_at`, a revocation `id` and read scopes. The original token is
returned on creation. SQLite stores its SHA-256 digest. Keys survive application
restarts and expire 24 hours after creation, regardless of subsequent usage.

Send the API key as a Bearer token on data requests.

```bash
curl "$BASE_URL/api/v1/sessions?limit=50&offset=0" \
  -H "Authorization: Bearer $API_KEY"
```

| Method and path | Response |
| --- | --- |
| `GET /api/v1/sessions` | Saved sessions with source, subject/set metadata and winner. |
| `GET /api/v1/sessions/{id}` | One session including recorded question IDs, titles and types. |
| `GET /api/v1/sessions/{id}/results` | Stored ranking and totals. |
| `GET /api/v1/sessions/{id}/answers` | Nickname, question ID, correctness, response duration and submission timestamp. |
| `GET /api/v1/sessions/{id}/attendance` | Nickname, avatar and join time. |
| `GET /api/v1/sessions/{id}/events` | Stored activity events such as tab switches and fast answers. |
| `POST /api/v1/auth/token/{id}/revoke` | Revoke a key using `X-Teacher-Key`. |

Session lists accept `limit` from 1 to 100, default 50. Record lists accept `limit`
from 1 to 500, default 100. All lists accept a nonnegative `offset`. Iterate until
an empty page. Returned lists contain `items`, `limit` and `offset`.

Data access is read-only. Issuing/revoking keys and importing banks require the
teacher key. An expired, revoked or incorrect API token returns 401. Missing
sessions return 404. Invalid request parameters return 422.

New sessions record their title, question list, source and subject/set selection
at creation. Historical sessions have `provenance: inferred_from_answered_questions`
when metadata can be reconstructed from question IDs, or `unavailable` when there
are no recorded answers. Inference uses the current bank and can cover only the
questions that received answers. `question_count` for inferred entries is therefore
an observed count, not the original total. `source: legacy` identifies these rows.

The API reads structured SQLite history. It reports stored scores and ranks and
retains an unfinished session's saved status. Raw Docker logs do not contain enough
information to reconstruct missing rankings. Raw submitted answer text was not
historically recorded in SQLite, so the answers endpoint returns correctness and
response times rather than inventing missing submissions. IP addresses, teacher
credentials, reconnect secrets and private answer keys are excluded from responses.

## Teacher import endpoint

`POST /api/teacher/imports` accepts `X-Teacher-Key` and a JSON object with `title`
and `tasks`. It returns `import_id`, count and preview metadata. The teacher
WebSocket starts it with `{"type":"start","importId":"...","test":false}` and
an optional `title`. The token is one-use and expires after an hour. Imports during
a running/finished session return 409. Invalid banks return 400 and oversized
requests return 413. Uploads preserve authored arrays and expected sorting states.
