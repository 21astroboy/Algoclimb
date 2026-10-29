# Deploying AlgoClimb

## First launch

On the VPS, install Docker with Compose and clone the repository:

```bash
git clone https://github.com/21astroboy/Algoclimb.git
cd Algoclimb
cp .env.example .env
```

Set the public URL and a private, permanent teacher key in `.env`:

```dotenv
PUBLIC_URL=https://algoclimb.example.com
TEACHER_KEY=replace-with-your-own-random-key
```

Upload private files from **your computer** to the server's `Algoclimb/secrets/` directory:

```bash
scp ./task-bank.json ./explanations.json user@server:~/Algoclimb/secrets/
```

Explanations are optional. Without a private bank, the public demo is used.
Run `./algoclimb up` on the server, then open `/teacher`.

| Command | Action |
| --- | --- |
| `./algoclimb up` | Build and start; also apply Compose/environment changes |
| `./algoclimb deploy` | Fetch `origin/main`, fast-forward and rebuild |
| `./algoclimb restart` | Restart the current container/process |
| `./algoclimb logs` | Follow application logs |
| `./algoclimb key` | Print the teacher key |
| `./algoclimb status` | Check the service |
| `./algoclimb down` | Stop the service |

A restart **does not rebuild** an image or apply changed Compose environment variables.
After updating code use `deploy`; after editing `.env` use `up`. After replacing only
mounted private bank/explanation files, `restart` is enough.

## HTTPS

Set up a reverse proxy with WebSocket support. For example, Caddy:

```caddyfile
algoclimb.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

When proxying locally, bind the Compose port to loopback in `docker-compose.yml`:

```yaml
ports:
  - "127.0.0.1:${PORT:-3000}:3000"
```

Use `./algoclimb up` to apply the change. The public URL should point to the HTTPS
proxy. Keep the backend port inaccessible from the public network when using a proxy.
For nginx, enable HTTP/1.1 WebSocket upgrade headers and long read/send timeouts.

## Configuration

The default config is `backend/config/config.example.json`. To customize it locally,
copy it to `backend/config/config.json` (ignored by Git). For Docker, explicitly mount
that file with a `docker-compose.override.yml`:

```yaml
services:
  algoclimb:
    volumes:
      - ./backend/config/config.json:/app/backend/config/config.json:ro
```

The working config is excluded from the Docker image. The Compose file passes the
supported environment overrides below; a direct Python launch can additionally use
`CONFIG_PATH` and `RUNTIME_DIR` (default: `backend/data/runtime`).

| Setting | Purpose |
| --- | --- |
| `PUBLIC_URL` | Public address embedded in the QR and join link |
| `PORT` | Published port (default 3000) |
| `TEACHER_KEY` | Permanent key; otherwise a key is generated at startup |
| `QR_ROTATION` | `1` enables rotating join codes; `0` disables; empty uses config |
| `QR_INTERVAL` | Rotation interval in seconds; empty uses config |
| `DOCS` | `1` enables the optional HTTP API documentation |
| `GSHEETS` | `1` enables Google Sheets exports with configured credentials |
| `TASK_BANK_PATH` | Bank path inside the container or direct Python environment |
| `EXPLANATIONS_PATH` | Explanation path inside the container or Python environment |

The existing nickname and QR sign-in flow is unchanged. QR codes gate initial entry;
reconnection currently restores an existing nickname. No extra attendance PIN is implemented.

Useful config sections:

- `demo`: random question selection when no explicit selection is made.
- `activeTasks`: ordered question IDs; empty uses the available bank.
- `timeLimits`: `choice` seconds for choice/blank; `graph` seconds for other types.
  A task's `timeLimit` overrides these values.
- `scoring`: base score, minimum fraction, streak increment and cap.
- `revealMs`: inter-question pause in milliseconds.
- `paramize`: fresh sorting arrays per session when enabled.
- `qrRotation`: enabled flag, interval, grace windows and optional secret.
- `gsheets`: service account, spreadsheet IDs, sheet/column mapping and awarded points.

Google Sheets export is optional. Place the service-account JSON in `secrets/`, share
the configured spreadsheets with its email, and configure `gsheets.streams` and the sheet
mapping. Start with the UI's **Preview**. Sheet names may remain Russian; translation of
the interface does not rename external spreadsheet tabs.

## Backup and recovery

Keep private copies of `secrets/`, `.env`, your working config, and `backend/data/runtime/`.
Runtime contains SQLite history, custom questions and the live-session snapshot. Store backups
outside the public repository.

For a simple consistent backup, schedule downtime and stop writes before copying:

```bash
./algoclimb down
# Copy the complete backend/data/runtime directory, secrets, .env and working config
# to your private backup destination while the app is stopped.
./algoclimb up
```

For an online SQLite backup, use SQLite's backup API rather than copying only the `.db`
file while WAL writes are active. A live snapshot can lag the latest in-memory state.

To restore, stop the service, restore the complete saved runtime and private configuration
with their original permissions, then run `up`. Verify history, the bank and a practice
session before a class. Test this procedure on an isolated copy first.

## Health and limits

`GET /healthz` checks that the process responds. Compose includes a healthcheck and autoheal.
An external uptime check is still useful: a deliberately stopped container does not become
unhealthy. The app supports one shared live session per process and **one Uvicorn worker**.
Do not add workers to scale it; they would have independent game states.
