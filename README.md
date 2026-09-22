<p align="center">
  <img src="https://raw.githubusercontent.com/anudeepd/lagun/main/assets/logo.svg" alt="Lagun" width="120"/>
</p>

<h1 align="center">Lagun</h1>

<p align="center">A minimal, web-based MySQL/MariaDB GUI editor. Install it, run it, use it.</p>

## Features

- **Web-based SQL editor** with syntax highlighting, autocompletion, and multi-tab support
- **Multi-statement execution** — run multiple statements at once, each result shown in its own sub-tab
- **Schema browser** — explore databases, tables, columns, and indexes; resizable sidebar
- **Schema management** — create, modify, and drop tables, columns, and indexes
- **In-line data editing** — edit cells, insert rows, delete rows directly in the grid
- **Import & export** — CSV and SQL formats with streaming for large datasets; export respects active column filters
- **Query history** — full SQL with word wrap, copy or load any entry back into the editor
- **Large write scripts** — normal Execute can run 25+ writes in one backend transaction with rollback
- **Bookmarks** — save and organize frequently used tables
- **Connection management** — import and export connection configs (both are refused with 403 while LDAP authentication is enabled)
- **Secure connections** — SSL/TLS, credentials stored in OS keyring, encrypted session backup
- **LDAP/AD authentication** — optional, via [ldapgate](https://github.com/anudeepd/ldapgate)

## Install

```bash
pip install lagun
```

Requires Python 3.11 or newer (the server uses `asyncio.timeout`). Check with
`python3 --version` before installing on an older host — `pip` will refuse the
install rather than failing at runtime.

## Usage

```bash
lagun serve
```

Opens the GUI in your browser. Connect to any MySQL or MariaDB database from there.

> [!WARNING]
> **Without `--ldap-config` there is no authentication.** Lagun is designed to be
> a local tool: anyone who can reach the port can read every saved connection
> (including its database credentials), run queries and change data. The default
> bind is `127.0.0.1` for that reason. `lagun serve --host 0.0.0.0` without
> `--ldap-config` publishes unauthenticated database access to everything that
> can reach the host — only do that on a trusted, isolated network. To serve
> other machines, enable LDAP and terminate TLS in front of Lagun; see
> [Deployment](#deployment).

### CLI options

| Command | Option | Default | Purpose |
| --- | --- | --- | --- |
| `lagun serve` | `--host TEXT` | `127.0.0.1` | Bind host. |
| `lagun serve` | `--port INTEGER` | `8080` | Bind port. |
| `lagun serve` | `--open` / `--no-open` | open | Open the browser after startup. Use `--no-open` under a service manager. |
| `lagun serve` | `--reload` | off | Auto-reload on code changes. Development only: it restarts the process and re-runs startup. |
| `lagun serve` | `--ldap-config PATH` | unset | ldapgate YAML config; enables LDAP authentication. |
| `lagun serve` | `--admin-user TEXT` | unset | LDAP username allowed to use the admin console. Repeat for several users; equivalent to `LAGUN_ADMIN_USERS`. |
| `lagun serve` | `--connections-config PATH` | unset | Server-managed connection profiles YAML. Requires `--ldap-config`. |
| `lagun serve` | `--log-file PATH` | unset | Append application logs to this file. Equivalent to `LAGUN_LOG_FILE`. |
| `lagun audit` | `--user TEXT` | all users | Only show events for this LDAP username. |
| `lagun audit` | `--since DATE/TIME` | no lower bound | Only show events at or after this ISO date/time, e.g. `2026-06-21`. |
| `lagun audit` | `--limit INTEGER` | `100` | Maximum rows, `1`–`10000`. |
| `lagun audit purge` | `--older-than INTEGER` | `90` | Delete audit events older than this many days (`1` or more). |
| any command | `--help`, `--version` | — | Usage text and the installed Lagun version. |

### Environment variables

Server settings are read by the Lagun process (set them before starting it);
frontend settings are baked into the SPA by the Vite build and never read by the
server. Neither can be changed from the UI.

| Variable | Default | Applies to | Purpose |
| --- | --- | --- | --- |
| `LAGUN_DB` | `~/.lagun/lagun.db` | server | Path of the local SQLite store (saved connections, settings, audit events). |
| `LAGUN_SQLITE_BUSY_SECONDS` | `10` | server | How long a metadata/audit write waits for the store lock. |
| `LAGUN_AUDIT_WRITE_WARNING_INTERVAL_SECONDS` | `60` | server | Minimum interval between warnings about failed audit writes; suppressed failures are counted in the next warning. `0` warns on every failure. |
| `LAGUN_DB_POOL_MAX_SIZE` | `10` | server | Upstream connections per saved database. |
| `LAGUN_DB_GLOBAL_CONNECTION_LIMIT` | `100` | server | Upstream connections leased across all sessions. |
| `LAGUN_DB_ACQUIRE_TIMEOUT_SECONDS` | `10` | server | Maximum queue wait before HTTP 503. |
| `LAGUN_DB_POOL_IDLE_SECONDS` | `900` | server | Close a pool unused for this long. |
| `LAGUN_DB_POOL_REAP_INTERVAL_SECONDS` | `60` | server | How often idle pools are reaped. |
| `LAGUN_DB_POOL_CLOSE_GRACE_SECONDS` | `5` | server | Grace period for in-flight connections on shutdown before a pool is force-terminated, so a stuck query cannot block process exit. |
| `LAGUN_QUERY_MAX_RUNTIME_SECONDS` | `30` | server | Deadline for a normal query execution. |
| `LAGUN_EXPORT_MAX_RUNTIME_SECONDS` | `300` | server | Deadline for a streaming export; a stream that runs longer is stopped with an explicit error instead of hanging. |
| `LAGUN_QUERY_MAX_RESULT_ROWS` | `100000` | server | Hard ceiling on rows returned by one query, regardless of the session limit. |
| `LAGUN_BULK_MAX_STATEMENTS` | `3000` | server | Statements allowed in one large write script. |
| `LAGUN_BULK_MAX_BODY_BYTES` | `2097152` (2 MiB) | server | Request body ceiling for a large write script. |
| `LAGUN_BULK_MAX_STATEMENT_BYTES` | `65536` (64 KiB) | server | Per-statement ceiling for a large write script. |
| `LAGUN_BULK_LOCK_WAIT_TIMEOUT_SECONDS` | `5` | server | InnoDB lock wait for a large write script. |
| `LAGUN_BULK_MAX_RUNTIME_SECONDS` | `120` | server | Deadline for a large write script. |
| `LAGUN_IMPORT_MAX_FILE_BYTES` | `1073741824` (1 GiB) | server | Uploaded import file ceiling. |
| `LAGUN_IMPORT_MAX_RUNTIME_SECONDS` | `900` | server | Deadline for one import, preview or apply; a file that runs longer is aborted instead of holding a connection slot indefinitely. |
| `LAGUN_IMPORT_MAX_BATCH_BYTES` | `524288` (512 KiB) | server | Size of one batched `INSERT` built during import. |
| `LAGUN_IMPORT_MAX_STATEMENT_BYTES` | `67108864` (64 MiB) | server | Largest single statement accepted from a SQL dump import. |
| `LAGUN_ALLOWED_DB_HOSTS` | empty (every host) | server | Egress allowlist for saved connections: exact hostnames, `*.suffix`, or IPs, comma-separated. Empty means no restriction. |
| `LAGUN_LDAP_CONFIG` | unset | server | Path to the ldapgate YAML config. Equivalent to `--ldap-config`. |
| `LAGUN_ADMIN_USERS` | unset | server | Comma-separated LDAP usernames allowed to use the admin console. Equivalent to repeated `--admin-user`. |
| `LAGUN_CONNECTIONS_CONFIG` | unset | server | Path to the shared-connections YAML. Equivalent to `--connections-config`; requires `LAGUN_LDAP_CONFIG`. |
| `LAGUN_LOG_FILE` | unset | server | Append application logs to this file. Equivalent to `--log-file`. |
| `LAGUN_LDAP_IDLE_TIMEOUT` | `0` | server, derived | Written by the server from ldapgate's `proxy.idle_timeout` when LDAP starts; reported by `GET /api/v1/config/server`. Not an operator knob. |
| `LAGUN_DEV` | unset | server, development only | Adds the Vite dev-server origin to CORS so `npm run dev` can call the API. |
| `VITE_LAGUN_BULK_WRITE_THRESHOLD` | `25` | **frontend build-time** | Write-statement count at which Execute switches to the large-write path. Baked in at `npm run build`. |
| `LAGUN_BULK_WRITE_THRESHOLD` | `25` | **frontend build-time only** | Fallback spelling read by `frontend/vite.config.ts` for the variable above. The server never reads it: setting it on a deployed instance has no effect. |

`LAGUN_DB` and the pool, query, bulk and import limits are resolved when the
module is imported, so they must be set before the process starts (for systemd,
in the unit's `Environment=`/`EnvironmentFile=`).

## LDAP Authentication

Lagun can require users to log in via LDAP/AD before accessing the editor. This uses [ldapgate](https://github.com/anudeepd/ldapgate) as FastAPI middleware — no separate proxy process needed.

```bash
pip install 'lagun[ldap]'
lagun serve --ldap-config /path/to/ldapgate.yaml
```

For login bursts across at least 200 active users, size LDAPGate's bounded
connection pool and deadline in `/path/to/ldapgate.yaml`:

```yaml
ldap:
  timeout: 30
  pool_size: 16
```

### Shared connections and audit log

For LDAP deployments, an administrator can provide connections centrally and
limit each one to selected LDAP usernames:

```bash
export LAGUN_DBS_PASSWORD='database-password'
lagun serve --ldap-config /etc/lagun/ldap.yaml --connections-config /etc/lagun/connections.yaml
```

```yaml
connections:
  - id: dbs-production
    name: DBS Production
    host: mariadb.internal
    port: 3306
    username: shared_mariadb_user
    password_env: LAGUN_DBS_PASSWORD
    default: true
    selected_databases: [app, analytics]
    allowed_users: [alice, bob]
```

Listed users can use the connection but cannot edit it. Removing it in the UI
only hides it for that user. LDAP users may also create private connections;
those are visible only to their owner. Edit this file and restart Lagun to
change shared access. Set `selected_databases` to limit the visible schema
browser/search scope for a managed connection; omit it or use an empty list to
show all non-system schemas the database user can access.

LDAP API activity is recorded in Lagun's local `lagun.db`, not in MariaDB.
By default that database is `~/.lagun/lagun.db`; set `LAGUN_DB` to relocate the
whole local store (saved connections, settings, and audit events), for example
`LAGUN_DB=/var/lib/lagun/lagun.db`. Read it from the server with `lagun audit` and purge old entries with
`lagun audit purge --older-than 90`.

For direct local HTTP usage, set `proxy.secure_cookies: false` in the ldapgate
config. Keep `secure_cookies: true` in production and run Lagun behind HTTPS
with `trusted_proxies` configured so LDAPGate can honor `X-Forwarded-Proto`.

When LDAP is enabled, a logout button appears in the top-right corner of the tab bar.

### Admin console

LDAP administrators can open `/admin` to inspect saved connection metadata,
review recent API activity, monitor live workspaces, and manage the LDAP
allowlist without restarting Lagun. Enable the screen with an explicit
administrator allowlist:

```bash
lagun serve \
  --ldap-config /etc/lagun/ldap.yaml \
  --admin-user alice \
  --admin-user bob \
  --connections-config /etc/lagun/connections.yaml
```

`LAGUN_ADMIN_USERS=alice,bob` is equivalent to repeating `--admin-user`.
Administrator access is LDAP-only and separate from `connections.yaml`
`allowed_users`; connection inventory never returns stored database passwords.
Access policy remains owned by LDAPGate and the server-managed connections file.
The Users & policy view atomically updates `ldap.allowed_users`, creates a
mode-restricted backup, revokes removed users' active LDAP sessions, and applies
changes to new logins immediately. It requires `ldap.allowed_users` to be an
explicit YAML list; group-only LDAP policy must be changed in its source
configuration instead.

The admin console also includes a live workspace view: authenticated browser
clients publish tab identity heartbeats, and active normal or bulk executions
are shown with session, database, tab, state, duration, and complete SQL. Live
table tabs also report the current schema/data view, database, table, row limit,
partial all-column search, and applied `WHERE` clause; un-applied filter drafts
are not reported. Presence is process-local and expires after 45 seconds
without a heartbeat.

Query and API audit records preserve raw request targets, including query
parameters, and complete JSON request bodies. The audit form supports
case-insensitive partial matching across user, method, path, SQL, filters, and
raw JSON; Enter applies the current filters. Read-only admin polling is omitted
so user database activity remains visible. Expanded bodies wrap and scroll
vertically in the console.

See the [ldapgate README](https://github.com/anudeepd/ldapgate) for config file documentation.

## Deployment

Lagun is a single-process application. Run **one instance per local `lagun.db`**;
the SQLite store and the in-process query cancellation state are not designed for
shared multi-process deployment. The HTTP API is plain HTTP, so terminate TLS in
front of it and keep the bind on loopback.

State and credentials:

- `LAGUN_DB` (`~/.lagun/lagun.db` by default) holds saved connections, settings
  and audit events. Back it up together with its `-wal`/`-shm` siblings.
- Database passwords are encrypted with a master key kept in the OS keyring, or
  in `~/.lagun/master.key` (mode 0600) when no keyring is available — the usual
  case for a service account. Keep the service account's `HOME` stable and
  writable: a different or wiped `HOME` means the stored credentials can no
  longer be decrypted, and Lagun reports that instead of guessing.
- Managed connection profiles from `--connections-config` are re-read at every
  startup, so edit the file and restart the service to apply changes.

### systemd

Install into a virtualenv owned by the service account, keep configuration in
`/etc/lagun`, and let systemd create the state directory:

```ini
# /etc/systemd/system/lagun.service
[Unit]
Description=Lagun MySQL/MariaDB GUI
Documentation=https://github.com/anudeepd/lagun
After=network-online.target
Wants=network-online.target

[Service]
User=lagun
Group=lagun
StateDirectory=lagun
Environment=LAGUN_DB=/var/lib/lagun/lagun.db
EnvironmentFile=-/etc/lagun/lagun.env
ExecStart=/opt/lagun/.venv/bin/lagun serve --host 127.0.0.1 --port 8080 --no-open --ldap-config /etc/lagun/ldap.yaml --admin-user alice --connections-config /etc/lagun/connections.yaml
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lagun
```

- `ExecStart` must stay on one line: systemd does not support shell line
  continuations in unit files.
- `--no-open` is required under a service manager — there is no browser to open.
- `EnvironmentFile=-/etc/lagun/lagun.env` (mode 0600, systemd `KEY=VALUE`
  syntax, no `export`) is the place for the secrets the service needs, for
  example `LAGUN_DBS_PASSWORD` used by `password_env` in `connections.yaml`, or
  a `LAGUN_ALLOWED_DB_HOSTS` egress allowlist.
- Drop `--ldap-config`, `--admin-user` and `--connections-config` only on a
  trusted single-user machine: without `--ldap-config` there is no
  authentication at all. Do not combine that with a non-loopback `--host`.
- `Restart=on-failure` is safe: the store is a file, and startup re-syncs the
  managed connections. A crash loop is visible in `journalctl -u lagun`.

### Reverse proxy and TLS

Terminate TLS at a reverse proxy, forward to the loopback bind, and let LDAPGate
know it is behind a proxy so session cookies stay `Secure`:

```nginx
server {
    listen 443 ssl;
    server_name lagun.internal.example;

    ssl_certificate     /etc/letsencrypt/live/lagun.internal.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/lagun.internal.example/privkey.pem;

    # Imports are streamed up to LAGUN_IMPORT_MAX_FILE_BYTES (1 GiB by default).
    client_max_body_size 1g;

    location / {
        proxy_pass http://127.0.0.1:8080;
        # Keep the public host in `Host`: the app compares it against the
        # browser's `Origin` to reject cross-site writes.
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # Must cover the longest server-side operation, or the proxy cuts a
        # request the app is still working on: imports are bounded by
        # LAGUN_IMPORT_MAX_RUNTIME_SECONDS (900s default) and exports by
        # LAGUN_EXPORT_MAX_RUNTIME_SECONDS (300s default).
        proxy_read_timeout 900s;
        proxy_buffering off;
    }
}

server {
    listen 80;
    server_name lagun.internal.example;
    return 301 https://$host$request_uri;
}
```

```yaml
# ldapgate config
proxy:
  secure_cookies: true
  trusted_proxies: [127.0.0.1]
```

Raise `client_max_body_size` and `proxy_read_timeout` together with
`LAGUN_IMPORT_MAX_FILE_BYTES` and the query/script deadlines if the deployment
imports or runs larger workloads than the defaults allow.

## Concurrent Deployments

Lagun bounds database work so bursts from many browser tabs queue instead of
opening unlimited upstream connections. The pool, deadline, bulk and import
limits are in [Environment variables](#environment-variables); their defaults
suit a single application instance serving a small or medium internal team.

Raise pool limits only after checking the connection ceilings and workload of
the target MySQL/MariaDB servers.

## Large Write Scripts

For large write scripts (25+ `INSERT`, `UPDATE`, or `DELETE` statements), Lagun
can send the entire script to the backend in one request from the normal Execute
button. The backend executes all statements in order inside one transaction and
rolls back on first failure.
Set `VITE_LAGUN_BULK_WRITE_THRESHOLD` (or its `LAGUN_BULK_WRITE_THRESHOLD`
fallback) when building the frontend to change the UI threshold; both are
frontend build-time settings that the server never reads. The server-side limits
are the `LAGUN_BULK_*` variables in
[Environment variables](#environment-variables).

See [docs/bulk-execution.md](docs/bulk-execution.md) for API details, limits,
admin configuration, and troubleshooting.

## Screenshots

<p align="center">
  <img src="https://raw.githubusercontent.com/anudeepd/lagun/main/assets/img_1.png" alt="SQL Editor" width="100%"/>
  <img src="https://raw.githubusercontent.com/anudeepd/lagun/main/assets/img_2.png" alt="Schema View" width="100%"/>
  <img src="https://raw.githubusercontent.com/anudeepd/lagun/main/assets/img_3.png" alt="Data View with Search" width="100%"/>
  <img src="https://raw.githubusercontent.com/anudeepd/lagun/main/assets/img_4.png" alt="Data View with Filter" width="100%"/>
</p>

## Development

Requires [uv](https://github.com/astral-sh/uv).

```bash
git clone https://github.com/anudeepd/lagun
cd lagun
uv sync
uv run lagun serve
```

## License

MIT
