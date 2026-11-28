# AlgoClimb: instructions for coding agents

Read [agents/README.md](agents/README.md) first. It indexes the architecture, product rules,
frontend conventions, tests and operations runbooks. This file applies to the whole repository.
The detailed guides describe the implementation as of 2026-11-28; inspect current code before changes.

## Required working rules

- Preserve active classes, stored student answers, session history and account access boundaries.
- Use one application worker. Game state, room locks and connected sockets are process-local.
- Never run tests against the production database or use production credentials in fixtures.
- Use a temporary `RUNTIME_DIR` for tests. Keep private banks, runtime state, invitations, passwords,
  resume secrets and API tokens out of Git, screenshots, logs and agent reports.
- Do not modify unrelated research files, notebooks, archives or untracked design prototypes.
- Keep English as the default interface language and preserve the teacher workspace EN/RU switch. Never translate user-authored question content or answers automatically.
- Maintain both `README.md` / `README.ru.md` and the relevant bilingual teacher guide when behavior changes.
- Keep ownership and subject checks on the server; hiding a UI control does not grant or revoke permission.
- Validate and authorize before mutating game state. Preserve question timing, scoring and reconnect semantics.
- Do not add SMTP dependencies to the invitation/recovery flow. Administrators distribute one-use links.
- Use focused tests that prove the changed behavior. For meaningful changes, complete the relevant CI checks.
- Before deployment, check for active rooms. Build and back up first; avoid restarting a live class.
  Existing authorization from the user still applies; do not add redundant approval steps.
- Never restart or change unrelated VPS services. Roll back code/images separately from persistent student data.

## Where to read next

- [Architecture and persistence](agents/architecture.md)
- [Product rules and data boundaries](agents/product.md)
- [Frontend, navigation and accessibility](agents/frontend.md)
- [Testing and diagnostics](agents/testing.md)
- [Deployment and incident response](agents/operations.md)

Use the user's current instructions over these defaults. When a guide and code disagree, investigate,
fix the discrepancy and update the guide; do not silently assume a documented feature exists.
