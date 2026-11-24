# Frontend conventions and interaction design

## Files and approach

- `workspace.html` loads `workspace.css`, `workspace.js`, shared `interactions.css` and `site-footer.js`.
- `workspace.js` is plain JavaScript with page state and string-rendered views; no build step/framework.
- `student.html` includes gameplay, answer widgets and connection management inline.
- `attendance.js` implements the student attendance prompt/check flow.
- Legacy teacher, answer-key and developer pages are still served; keep shared assets compatible.
- `site-footer.js` renders the copyright, source/license link and public contacts on all main pages.

The public interface is English. Bank content is escaped/preserved in its own language. Use `esc()`
for untrusted strings in generated HTML, and use text content for errors. Never interpolate an uploaded
prompt, student name or URL into executable JavaScript/HTML without the correct boundary handling.
Do not use internal implementation details in ordinary teaching flow labels.

## Action handling

`button()` allocates a callback in the `events` map and renders a `data-action`. A delegated document
click listener dispatches actions and surfaces errors. `pruneActions()` removes handlers no longer
represented in the DOM after rendering. Do not attach a new document listener during each render.
The generic handler uses an in-flight busy marker to prevent duplicate activation of the same button.
Keep SVG marker keyboard handling compatible with the action map.

Views frequently re-render after teacher state updates. Preserve search input focus/caret and scroll
containers with `data-preserve-scroll`. Do not rebuild class-wide answer detail on every socket message.
The climb-board fixture verifies handler cleanup and filter/focus behavior with large rosters.

## Navigation

- The AlgoClimb logo is a real link to `/workspace` with client-side navigation to Overview.
- Each non-home section has a visible `← Back` button.
- `navigationTrail` keeps a bounded in-app page trail; navigating back does not finish or reset a room.
- Detail back actions return student → student matrix, question → question list, report tab → overview,
  report overview → report list. Generic section navigation returns to the previously visited section.
- Opening a room can reconnect the teacher socket; it must not create a new student session or reset scores.
- Dialogs have a back/close control and Escape dismissal. Closing a dialog leaves its underlying page.
- This is in-app navigation, not a promise of browser URL/history synchronization. Do not use an unguarded
  `history.back()` that can eject a teacher from the application.

## Buttons and accessibility

Use clear normal, hover, pressed, keyboard-focus, busy and disabled states. Secondary buttons have a
contrasting pale background/border; yellow primary buttons identify the main action. Color alone is not
sufficient feedback: borders/shadows/focus outlines also change. Maintain readable contrast in dark pages.
Shared styles use `:focus-visible`, `touch-action` and reduced-motion support. Avoid hover-only controls.
Do not rely on a tooltip for a destructive command; keep the existing concrete confirmation.

Dialogs use `role="dialog"`, a name and `aria-modal`. The application behind an open dialog is inert;
keyboard focus stays inside, and dismissal restores focus when the trigger still exists. Keep hidden
attendance fields out of the focus order. Verify Tab/Shift+Tab and small-screen scrolling after edits.

## Session preparation

The form is grouped into:
1. Class details: title/group and correctness reveal policy.
2. Collapsible optional timing by question type. Empty inputs retain defaults; set bounds 5–3600 seconds.
3. Optional location attendance. Radius/options appear only when enabled.

The selected-bank summary explains what will run. Opening a lobby does not immediately start the quiz.
The primary action stays visually distinct. Keep the dialog responsive with one-column fields on phones
and two columns when space allows. Invalid input should leave the form open with a readable error.
Restore existing lobby settings when revisiting preparation, without exposing teacher raw coordinates.
Client validation is convenience; server validation remains mandatory.

## Analytics and live telemetry

Live teacher payloads already include per-student `tabLeaves`; surface these without another polling API.
Saved reports derive counts from timestamped `tableave` records. Keep UI labels readable (`Tab left`),
but preserve the wire/storage identifier for compatibility. Explain that visibility events are not proof
of cheating. Avoid popup placeholders for report tabs: they render distinct useful content.

## Visual verification

Use synthetic data and Playwright. Check 390px, laptop and desktop widths. Verify modal overflow, long
names, large rosters (60–120), many questions (30+) and keyboard navigation. Never take documentation
screenshots from a real class or an administrator page containing invitation/API tokens.
`CHROME_PATH` can select installed Chrome locally; CI installs Playwright Chromium.
Version workspace asset URLs when updating the script/style pair. Test static paths after deployment.
