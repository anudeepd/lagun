# Changelog

All notable changes to Lagun are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.94] - 2026-09-22

Remediation of the 2026-09-22 audit, grouped by the audit lens each change came
from. Finding ids (`S-3`, `U-10`, …) refer to that report.

### Security

- **Per-connection scope is now a ceiling, not a default** (`S-1`): the
  administrator's `selected_databases` list is stored separately, users may only
  narrow it, and an empty list means "everything the administrator allowed"
  rather than "everything on the server".
- **Scope is enforced on export and import** (`S-2`): a scoped connection can no
  longer export another schema or write into one by importing a CSV or a
  `mysqldump` file, including through DDL, executable comments and
  `PREPARE`/`EXECUTE`.
- **Audit bodies are redacted** (`S-3`, `OPS-01`): `password`, `passphrase`,
  `secret`, `token`, `password_enc`, `new_password` and `old_password` values are
  replaced with `***` before an event is stored, and an unparseable body is
  recorded as a marker instead of raw bytes.
- **Bulk-script cancellation checks ownership** (`S-4`) and answers exactly like
  a nonexistent execution id on mismatch, so ids cannot be probed.
- **The auto-`LIMIT` safety net cannot be bypassed** (`S-5`) by a leading
  comment, a CTE or a MySQL executable comment, and no longer appends `LIMIT` to
  statements whose grammar rejects it (`DESCRIBE`, `SHOW`, `EXPLAIN`) or before a
  locking clause.
- **Bulk row deletion is bounded** (`S-6`): 10,000 keys per request, the query
  deadline is shared, and the echoed statement list is capped.
- **Outbound connections are allowlisted** (`S-7`): new `LAGUN_ALLOWED_DB_HOSTS`
  applies to probes, connection tests, queries, schema browsing and export, and
  is re-checked at connect time so a session saved earlier cannot keep reaching a
  now-disallowed host.
- **CSV export neutralises spreadsheet formulas** (`S-8`) while leaving numeric
  literals such as `-5` unchanged.
- **Export validates the statement instead of matching a blocklist** (`S-9`):
  only a result-producing `SELECT`/CTE is accepted, and `INTO OUTFILE`,
  `INTO DUMPFILE` and executable comments are refused outright.
- **Response hardening applies in the default mode too** (`S-10`): the CSP gains
  `base-uri`, `form-action`, `frame-ancestors` and `object-src`, plus
  `X-Content-Type-Options`, `Referrer-Policy` and `X-Frame-Options`.
- **Cross-site writes are rejected** (`S-11`): state-changing `/api/*` requests
  from a foreign `Origin`, or with `Sec-Fetch-Site: cross-site`, return 403.
- **SQL string literals escape backslashes** (`S-12`), so values such as
  `C:\Users\test` round-trip through generated DDL and DML.
- **Master-key handling is atomic and loud** (`S-13`): the fallback key file is
  created `0600` without a write-then-chmod window, `~/.lagun` is `0700`, an
  existing key file is tightened on use, the keyring fallback warns, and a key
  change is reported as an actionable error instead of an opaque failure.
- **Config import is idempotent** (`S-14`): entries carry a source id and a
  duplicate connection is counted in `skipped` instead of being created again.

### Correctness

- **"Unique" in the index dialog creates a unique index** (`C-1`, `C-2`): the
  dialog posts `unique`, the request type matches the API, and a regression test
  asserts the exact request body.
- **`modifyColumn` requires `type`** (`C-3`) in the client signature, matching
  the API contract.
- **Result sub-tabs pluralise correctly** (`C-4`): `Result 1 (1 row)`.

### Data fidelity

- **Unsafe values become hex literals** (`F-1`): backslashes, NUL and `\x1a` in
  exported SQL are emitted as `CONVERT(0x… USING utf8mb4)` instead of a
  backslash-escaped string.
- **`TIME` values are written as `HH:MM:SS[.ffffff]`** (`F-2`) rather than as
  Python `timedelta` reprs.
- **Identifiers are quoted by doubling backticks** (`F-8`), so names MySQL
  allows (`my-db`, `my table`, `café`, a name containing a backtick) work.

### API

- **Interactive API docs are development-only** (`API-2`): `/docs`, `/redoc` and
  `/openapi.json` are served only with `LAGUN_DEV` set, instead of shipping a
  Swagger UI that cannot load.
- **Server-side deadlines cover imports, exports and single-row writes**
  (`API-6`): an import stops at `LAGUN_IMPORT_MAX_RUNTIME_SECONDS` (900 s) and a
  streaming export at `LAGUN_EXPORT_MAX_RUNTIME_SECONDS` (300 s), both with an
  explicit error, and cell/row insert, update and delete share the query
  deadline instead of running unbounded.
- **`/healthz` and `/readyz` exist** (`API-9`, `OPS-03`): liveness always answers
  200, readiness answers 503 until startup finishes and during shutdown, so a
  load balancer or container policy has something to probe.
- **Every long operation has a deadline** (`API-6`): queries and single-row
  writes 30 s, exports 300 s, imports 900 s, each with an environment variable.
  The browser's own deadline is 120 s and is not applied to bulk scripts, whose
  bound is operator-tunable.
- **A caller-supplied `X-Request-ID` is echoed only if it is short and plain**
  (`D-3`), so a correlation id cannot forge log lines or bloat a header.

### Accessibility

- **The connection list is keyboard navigable** (`A-1`, `A-2`): rows are real
  buttons carrying `aria-current`, and every icon-only row action has an
  accessible name with `aria-haspopup`/`aria-expanded` on a real menu.
- **The command palette and the keyboard help are complete** (`A-3`, `A-8`): the
  palette is a `combobox` with arrow-key navigation and
  `aria-activedescendant`, and the shortcut sheet renders every implemented
  shortcut.
- **Hit targets, dialogs and disclosures** (`A-4` … `A-7`, `A-9` … `A-11`): a
  shared 24×24 (44×44 on coarse pointers) hit target, `role="alertdialog"` with an
  associated message, a keyboard-operable Query Log whose collapsed body is
  `inert`, grid shortcuts scoped to the active grid, no `aria-live` on the whole
  admin console, and modals that focus the first control.
- **Native UI follows the dark theme** (`A-12`): `color-scheme: dark`.
- **Loading feedback is announced wherever a region loads** (`M-8`), not only in
  the session list: the schema tree, both config dialogs and the session form now
  carry one status region each, and the decorative spinners are `aria-hidden`.
- **The admin console's focus rings match the rest of the app** (`AC-1`), its
  add-user button validates on submit instead of being silently disabled
  (`AC-2`), the username field has a `name` (`AC-3`), and an error toast is no
  longer nested inside a second live region (`AC-4`).
- **The login page declares `color-scheme: dark`** (`ALC-1`) like the app does,
  so its scrollbars, autofill and form-control internals follow the dark theme.
- **A failed sign-in focuses the error it rendered** (`ALC-2`) — a live region
  only announces content inserted after load, and this alert is in the initial
  document — and the alert and the page's only link both have a visible focus
  ring (`ALC-4`: 1.07:1 before, 4.85:1 after).
- **The login page has a heading and a `main` landmark** (`ALC-3`) without
  changing a pixel of its appearance.

### Legibility

- **One compliant muted token** (`V-1`, `V-2`, `V-4`): `text-slate-500`/
  `text-slate-600` are replaced by a single AA-contrast `muted` colour, used for
  the `NULL` treatment in both views, and focus rings moved off `brand-500`.
- **Primary buttons stay readable on hover** (`V-3`).
- **Two placeholder-only fields have accessible names** (`V-5`).

### Interaction

- **Failures are visible instead of silent** (`U-1`, `U-6`): an unreachable
  connection is reported inline, and a failed schema refresh keeps the expanded
  groups and shows the error.
- **Row insert/delete has a visible affordance** (`U-2`), and `Create Table` is
  reachable from the database context menu (`U-5`).
- **Run is disabled until a database is selected** (`U-3`), and the bulk-confirm
  guard no longer discards results on the ≥25-statement path (`U-4`).
- **The admin audit view states its own window** (`U-7`) and points at
  `lagun audit --since` for older events.
- **Tooltips are keyboard accessible** (`U-8`), the tab strip no longer reserves
  a scrollbar track (`U-9`), and row counts are formatted by one shared helper
  (`U-10`).

### Motion

- **The modal no longer animates `backdrop-filter`** (`M-1`): the blur is a
  static class and only the fade runs.
- **`will-change` is scoped to the transition that needs it** (`M-2`) instead of
  sitting permanently on every mounted tab panel, and the panel entrance keyframe
  no longer animates `filter: blur()` (`M-3`).
- **The four collapsible sections animate opacity and transform** (`M-9`) rather
  than `height`, which forced a layout pass per frame; measured on a 400-row
  disclosure, 2 layouts instead of 32.
- **Full-viewport surfaces respect the hardware insets** (`M-10`) via a
  `safe-area-inset` utility, so a notched device does not clip them.
- **Headings and body copy use `text-balance`/`text-pretty`** (`M-7`) and the
  micro-label convention is one shared `Label` component (`M-4`), which also
  removes an arbitrary `z-[1]` (`M-5`) and the last gradient (`M-6`).

### Performance

- **The schema view loads only the SQL grammar** (`P-2`) instead of the whole
  highlight.js pack.
- **The bundle-size warning threshold is meaningful again** (`P-3`), and the
  chunk groups match the emitted chunks (`DEP-10`).

### Frontend

- **The primary-key dialog shows the current key** (`FE-2`) instead of starting
  from an empty selection.
- **Presence payloads are clamped to the API limits** (`FE-15`), so a long tab
  label or more than 100 tabs no longer makes the whole heartbeat fail with 422.

### Operability

- **Shutdown is bounded** (`OPS-04`): pool draining is capped by
  `LAGUN_DB_POOL_CLOSE_GRACE_SECONDS` (5 s) and a pool still holding leased
  connections is force-terminated, so an in-flight query can no longer block
  process exit indefinitely.
- **The local store is migrated by a numbered migration runner** (`OPS-02`)
  keyed on `PRAGMA user_version`, replacing ad-hoc `ALTER`s that swallowed every
  error.
- **Audit-write failures are reported** (`OPS-12`): a failed audit write logs a
  warning naming the error, rate-limited by
  `LAGUN_AUDIT_WRITE_WARNING_INTERVAL_SECONDS` (60 s) with the suppressed count,
  instead of being swallowed silently.
- **The whole configuration surface is documented** (`OPS-06`): every CLI flag
  and every environment variable now has a row in the README with its default and
  its scope, and `LAGUN_BULK_WRITE_THRESHOLD` is documented as the frontend
  build-time setting it actually is.
- **Deployment guidance and the local-only warning** (`OPS-07`): the README
  explains that without `--ldap-config` there is no authentication, and adds a
  systemd unit and a reverse-proxy/TLS example.

### Packaging and dependencies

- **The Python floor matches the code** (`DEP-04`, `H-5`):
  `requires-python = ">=3.11"`, because the query runner uses `asyncio.timeout`;
  3.10 is dropped from the classifiers and 3.13 added.
- **One version source** (`DEP-05`, `H-2`): `lagun.__version__` comes from the
  installed distribution metadata, falling back to `pyproject.toml` for an
  uninstalled checkout, and the FastAPI app reports it instead of its own
  hardcoded literal.
- **Runtime dependencies carry compatible-release ceilings** (`DEP-07`), so a
  new major of a direct API dependency cannot be picked up silently.
- **`uvicorn[standard]` is a development extra** (`DEP-08`); production installs
  get plain `uvicorn`, and `lagun serve --reload` still works through the
  StatReload fallback.
- **Third-party notices are generated, not hand-written** (`DEP-01`, `DEP-02`):
  `scripts/generate-third-party-licenses.py` (also `make licenses`) rebuilds
  `THIRD_PARTY_LICENSES.txt` from the production dependency closure, so the
  bundled JavaScript and CSS dependencies are attributed too.
- **The sdist no longer ships the test suite** (`DEP-12`): `MANIFEST.in` prunes
  `tests/` and `e2e/`, and the PyPI metadata gains Documentation/Changelog URLs,
  the `Framework :: FastAPI` and `Typing :: Typed` classifiers and the
  `py.typed` marker.
- **The release build is reproducible** (`DEP-11`): `make build` installs the
  frontend with `npm ci` and runs `uv lock --check` before `uv build`.
- **The stray root `package-lock.json` stub is gone** (`DEP-09`), along with the
  `.gitignore` line that only existed to hide it.

### Tests and CI

- **The data path is covered through the real component wiring** (`FE-6`): MSW
  handlers for `/query`, `/cell-update`, `/row-update`, `/row-insert` and
  `DELETE /rows` back tests that click Apply and Delete and assert both the
  outgoing request and what the user then sees — the previous tests exercised the
  pure helpers only, so a break in the handler wiring stayed green.
- **Continuous integration** (`H-1`): `.github/workflows/ci.yml` runs
  `uv lock --check`, `ruff check lagun/`, `pytest tests/` and, in `frontend/`,
  `npm ci && npm run test` on every push and pull request.
- **The CLI has tests** (`H-3`): `tests/test_cli.py` covers `lagun serve`
  option parsing, the environment it exports, the startup guard that requires
  `--ldap-config` with `--connections-config`, and the `lagun audit` /
  `lagun audit purge` argument handling.
- **The startup path has tests** (`H-4`): `tests/test_lifespan.py` boots the app,
  asserts the local store is initialised and serving, and asserts that a
  misconfigured `connections.yaml` fails with
  `RuntimeError("Invalid LAGUN_CONNECTIONS_CONFIG at <path>: <detail>")`.
- **The admin and presence routes are covered over HTTP** (`H-6`):
  `tests/api/test_admin_http.py` exercises the admin gate (403 for a non-admin,
  401 without an identity, 403 without LDAP), the admin listings and the presence
  round-trip, instead of calling handler functions directly.
- **The data path is covered through the real component wiring** (`FE-6`): MSW
  handlers for `/query`, `/cell-update`, `/row-update`, `/row-insert` and
  `DELETE /rows` back tests that click Apply and Delete and assert both the
  outgoing request and what the user then sees — the previous tests exercised the
  pure helpers only, so a break in the handler wiring stayed green.

### Upgrade notes

Things an operator should know before deploying this revision. Everything else in
this release is behaviour-preserving at the HTTP boundary.

- **Python 3.11 or newer is required** (`DEP-04`). `requires-python` now matches
  what the code actually uses (`asyncio.timeout`), so a 3.10 host gets a `pip`
  error at install time instead of a runtime failure.
- **`uvicorn[standard]` moved to the `dev` extra** (`DEP-08`). A production
  install now gets plain `uvicorn`; add `uvicorn[standard]` yourself if you want
  uvloop/httptools. Nothing in the app imports what that extra provided.
- **`/openapi.json`, `/docs` and `/redoc` are development-only** (`API-2`). They
  are registered only when `LAGUN_DEV` is set; a deployed instance answers those
  paths with the SPA shell. Tooling that read the schema from production must set
  `LAGUN_DEV` or read it from a checkout.
- **Security response headers are now sent in the default (non-LDAP) mode too**
  (`S-10`): `Content-Security-Policy` with `frame-ancestors 'none'`,
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer`. Do not deploy inside an iframe.
- **State-changing `/api/` requests are refused when they come from another
  site** (`S-11`). `Sec-Fetch-Site` decides when the browser sends it;
  otherwise the browser's `Origin` is compared with `Host`, and
  `X-Forwarded-Host` is accepted as an alias so a reverse proxy that rewrites
  `Host` does not turn every write into a 403. Clients that send neither header
  (curl, server-to-server) are unaffected.
- **New server-side deadlines**: `LAGUN_QUERY_MAX_RUNTIME_SECONDS` (30, now also
  covering single-row writes), `LAGUN_EXPORT_MAX_RUNTIME_SECONDS` (300) and
  `LAGUN_IMPORT_MAX_RUNTIME_SECONDS` (900). A reverse proxy's read timeout must
  be at least as long as the import bound; the nginx example in the README uses
  `900s`. The browser abandons a request after 120s by default, except bulk
  scripts, whose bound is operator-tunable and which the UI can cancel.
- **Audit purge reclaims disk** (`OPS-05`): a purge that removes a large share of
  the table now `VACUUM`s and checkpoints the WAL, which takes an exclusive lock
  for the duration. Run it off-peak on a large store.
- **`lagun.db` is migrated and stamped on startup** (`OPS-02`) with
  `PRAGMA user_version`; a failed migration aborts startup with the migration
  number and cause instead of continuing on a partial schema. Still one process
  per database file.
- **`LAGUN_ALLOWED_DB_HOSTS`** (`S-7`) restricts every outbound database
  connection when set. Leave it unset to keep the previous behaviour.

### Repository hygiene

- **The 17 committed dev and probe scripts are gone** (`H-7`), along with the
  committed `test-results/.last-run.json` (`H-8`); `test-results/`, the pytest
  and ruff caches are now ignored explicitly (`H-12`).
- **`e2e/package.json` matches the project** (`H-10`): version `0.1.93`, licence
  MIT.
