# Deployment and incident response

## Inventory: verify before acting

Known deployment at the time of writing:
- SSH alias: `algoclimb`.
- Checkout: `/root/algoclimb`.
- Compose service/container: `algoclimb`.
- Runtime mount: `/app/backend/data/runtime` from the checkout runtime directory.
- Private bank mount: `/app/secrets`, read-only.
- Loopback application port: `127.0.0.1:3000`, behind a reverse proxy with HTTPS.
- Public workspace: `https://algoclimb.2.27.41.60.sslip.io/workspace`.
- Health endpoint: `/healthz`.

Other applications share the host. Do not run global Docker stop/prune, modify the shared proxy's other
host blocks, or redeploy unrelated Compose projects. The SSH alias is not permission to inspect unrelated
private data. Do not print `.env`, credential files, private bank contents or full startup logs.

## Preflight

1. Inspect local Git status and the exact commit to deploy. Preserve unrelated files.
2. Run focused tests and required CI checks. Review the final diff, not only test output.
3. Inspect remote branch/worktree state before updating; never discard unknown remote changes.
4. Inspect room status/participant counts without printing names or resume tokens.
   Room snapshots use `room-*.json`; `*state*.json` alone misses personal rooms.
5. If a class is running, build the image without replacing the active container. Deploy a frontend-only
   fix without restart when safe, or coordinate a brief interruption under existing user authorization.
6. Take a consistent SQLite backup through the SQLite backup API, plus relevant runtime snapshots.
   A naive copy of an open database may miss WAL data. Store backups privately outside the image/context.
7. Record the old commit and image tag so rollback is concrete.

## Shipping

Normal flow is fast-forward to the verified commit, `docker compose build algoclimb`, then
`docker compose up -d --no-deps algoclimb`. Avoid `down`: it is unnecessary and broadens the interruption.
Confirm the runtime and private-bank mounts are unchanged. One Uvicorn worker and wsproto remain required.
Do not run migrations by editing live SQLite tables ad hoc unless the task specifically needs a data repair.

If GitHub access on the VPS hangs, a local Git bundle is an alternative:

```bash
git bundle create /tmp/algoclimb-release.bundle <remote-base-commit>..HEAD
scp /tmp/algoclimb-release.bundle algoclimb:/root/algoclimb-release.bundle
```

On the VPS, fetch the bundle into the tracking ref and merge fast-forward. Verify the fetched head first.
A bundle is a transport mechanism, not a reason to bypass tests or overwrite remote work.

Static-only releases may copy files into the running container using temporary names and atomic rename.
Update both the checkout and a reproducible image/build path, otherwise the next recreate can lose the fix.
Copy shared assets first and HTML references last. Preserve the container start time to prove no restart.
Never hot-copy Python files and assume the already imported module changed; backend updates need a restart.

## Post-deploy checks

- `/healthz` succeeds through the public HTTPS URL and loopback.
- Docker status reaches `running healthy`; an initial `starting` is not the final health check.
- Source/script hashes or a visible behavior check match the intended release.
- Public HTML loads the newly versioned JS/CSS and shared footer/interaction assets.
- WebSockets still use WSS through the proxy; no mixed-content or asset 404 errors.
- Existing rooms recover and saved answers remain available if a restart occurred.
- GitHub CI finishes successfully. Distinguish an in-progress run from a passed one.

Read filtered errors when needed; startup logs can contain bootstrap secrets. Query only the relevant
window and fields. Do not paste logs verbatim into chat without checking for tokens/identities.

## Rollback

Restore the previous code/image while retaining the persistent runtime volume. Do not automatically
restore an older database: that would erase answers received since the backup. Data restoration is a
separate, potentially destructive recovery action requiring explicit scope and a reasoned plan.
If a new schema is additive, old code may still work; verify compatibility instead of assuming it.

## Troubleshooting examples

| Symptom | Inspect | Avoid |
| --- | --- | --- |
| `Method Not Allowed` closing room | HTTP method, route and non-empty room ID; legacy service game exclusion | deleting history to remove a UI row |
| Students lose connection | correlation IDs/recovery reasons, socket liveness, server restarts, Wi-Fi | assuming cheating or server overload without evidence |
| No tab-leave count | question screen, visibility event, open socket, practice mode, stored events and UI column | inventing historic events |
| Timer mismatch | effective Game duration, milliseconds vs seconds, deadline, resume message and client clock sync | independent frontend-only countdown rules |
| Teacher cannot see report | ownership/sharing and current subject grants | granting administrator as a shortcut |
| Form seems unchanged | versioned asset URLs, browser cache and served file hashes | repeated backend restarts for stale CSS |
| Geolocation fails | HTTPS, permission, accuracy, radius and manual review | using public IP as room attendance proof |
