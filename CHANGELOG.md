# Changelog

All notable changes to Lagun are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.98] - 2026-09-29

### Fixed

- **Two eye icons on the LDAP login page in Firefox.** Firefox can draw its own reveal button
  inside `<input type="password">` (`layout.forms.reveal-password-button.enabled`: on in
  Nightly, some forks and any profile that sets it), next to the page's own toggle. The
  existing `::-ms-reveal` rule only hides Edge's. Page CSS cannot hide Firefox's:
  `::-moz-reveal` is user-agent-only, and painting it invisible is undone by Firefox's
  `input:autofill { color: FieldText !important }`. The page now measures whether the browser
  reserves room for its own button and, if it does, shows only that one. The
  `login-reveal` e2e spec runs the real template in Firefox with the button on and off.
- The login pages of lagun, xwing, torrus and ldapgate (its template and its built-in fallback)
  are now one page apart from branding (palette, logo, name, title, asset paths). Shared
  behaviour: guarded `sessionStorage` access, so blocked storage can no longer throw after a
  failed sign-in; `aria-invalid` on both fields after a failure; the error takes focus and the
  username is only autofocused when there is no error; the floating error banner (xwing's used
  to sit in the flow); an `<h1>` and `<main>` landmark everywhere (torrus used a hidden
  heading, ldapgate a `<span>`); `color-scheme: dark`; safe-area padding with `theme-color`;
  focus-visible outlines; and the "Signing in…" label.
- **UI consistency pass.** Tailwind emitted no CSS for `surface-600`, `brand-200/300/800/950`
  and other shades the components used, so `Button` secondary borders rendered near-white and
  `text-brand-300` / `bg-brand-950` fell back to inherited colours. Both palettes are now complete.
- Text fields (`Input`, `Select`, `LimitSelect`) no longer lift on hover or squash on press;
  they use the new `.lagun-field` transition. Compact toolbar icon buttons
  (`Button variant="icon" size="sm"`) match the height of neighbouring `sm` controls.
- Dialogs use one error/warning/success banner style, Cancel-then-primary button order,
  `accent-brand-500` checkboxes and one focus ring; hand-rolled buttons and fields in the admin
  console use the shared `Button`, `Label` and field classes; amber replaces yellow and green
  replaces emerald for warning/success.
- Sticky Columns-table cells match the page surface, the SQL editor uses the app's slate palette,
  the logout button no longer renders with a permanent red background, views show an eye
  icon in the schema tree, and a table tab's truncated label carries a `title` with the full
  `database.table`.

## [0.1.97] - 2026-09-27

### Tests and CI

- **vitest 3 → 4.1.11.** vitest 3's jsdom environment copied jsdom's
  `AbortController`/`AbortSignal` over the Node globals, and the `fetch` the tests
  run against is Node's own, which refuses a signal it did not create — 15 tests
  across 7 files failed with `RequestInit: Expected signal (...) to be an instance
  of AbortSignal` the moment requests started carrying deadlines (0.1.96). vitest 4
  fixes that upstream (vitest-dev/vitest#8390), so the environment wrapper 0.1.96
  shipped (`frontend/src/__tests__/environment.ts`) is deleted and
  `environment: 'jsdom'` is back. `@vitest/ui` moves to the same version, and
  `poolOptions.forks.execArgv` becomes the top-level `execArgv`, because vitest 4
  removed `poolOptions`.

## [0.1.96] - 2026-09-27

Regressions introduced between 0.1.92 and 0.1.95, plus the hardening and the
import/export progress and admin-pagination work this pass added around them.

### Security

- **Scope covers the schemas a raw statement actually names.** A qualified read
  (`SELECT * FROM other_db.t`), a qualified write, a `USE`, a schema-qualified
  routine call and now also a qualified object name (`CREATE VIEW other_db.v`,
  `DROP TRIGGER other_db.trg`, `DROP INDEX i ON other_db.t`,
  `ALTER TABLE t RENAME TO other_db.t2`) are refused on a scoped connection.
  CTE-wrapped writes resolve their target instead of failing closed. The
  introspection schemas (`information_schema`, `performance_schema`, `sys`) are
  readable; `mysql` is not. `GRANT`/`REVOKE` and dynamic SQL
  (`CALL`/`PREPARE`/`EXECUTE`/`DEALLOCATE`) stay refused, and the deeper gate
  remains the MySQL user's grants.
- **`Sec-Fetch-Site: same-site` is no longer trusted on its own.** A write from a
  foreign Origin on the same registrable domain (a sibling subdomain, another
  port) sends `same-site`; the Origin is now checked in that case too.
- **Binary columns only decode `0x`-prefixed text.** Any other text — including
  even-length hex that is not a hex literal — round-trips unchanged instead of
  being silently rewritten to bytes.
- **`/healthz` and `/readyz` are reachable without a session** in LDAP mode:
  a probe that cannot log in must not be answered with a redirect or 401.
- **Scope on free-form SQL is decided by a text analyser, not by MySQL.** It now
  follows the lexer where it had diverged: a `--` comment needs whitespace after
  the second dash, a backtick identifier is opaque (a quote inside it is part of
  the name, not a string), a parenthesised table factor and `STRAIGHT_JOIN` are
  table positions, an inter-token comment cannot separate a verb from its name,
  `IF [NOT] EXISTS` cannot hide an object's schema, and a multi-table `DELETE`
  resolves the target list before `FROM` rather than the source tables. One
  divergence remains and cannot be closed without knowing the server's
  `sql_mode`: with `ANSI_QUOTES` a double-quoted token is an identifier, and the
  analyser reads it as a string (with `NO_BACKSLASH_ESCAPES`, a backslash inside
  a string is likewise read as an escape). For a scoped connection the MySQL
  user's own grants remain the authoritative gate; treat this check as a second
  line, not the last one.
- **Audit redaction is a substring test, not a list of exact names.** A request
  field whose key contains `pass`, `secret`, `token`, `key`, `auth`, `cookie` or
  `credential` is stored redacted, so keys such as `monkey` or `keyboard` no
  longer slip past the seven names 0.1.94 matched. Every stored body is also
  capped at 16 KiB and marked `[truncated]`, so an audit row cannot grow with the
  payload it describes.

### Fixed

- **Sign-in survives blocked storage.** The login page's username prefill and
  persist calls are guarded again, so a browser that denies `sessionStorage`
  (private mode, blocked cookies) can still submit.
- **A failed schema refresh no longer looks like an empty connection.** The tree
  keeps the schemas it had open and the filter, and reports the failure; before,
  the failure resolved as an empty listing and silently collapsed everything.
- **A dialog kept mounted for its exit animation can no longer be hijacked by the
  previous open's request.** The connection form, the modify-column dialog and
  the export dialog fence completions with a close-time request generation and
  reset their in-flight state on open, so a late response no longer closes or
  repaints the next open — including the case where the abandoned write left the
  Save button permanently disabled.
- **The mobile drawer cannot wedge the workspace.** Widening the viewport past
  `lg` closes it instead of leaving the main area `inert` behind a hidden
  overlay.
- **Each connection row's action menu has its own ref**, so the menu opened
  second keeps keyboard navigation and focus.
- **A refresh tick no longer discards a finished "load older" page** in the admin
  console.
- **Grid popovers clamp against the layout box**, not the box mid enter-animation,
  so a tab or cell menu settles fully on screen.
- **Shift+Enter with the find bar open steps to the previous match** instead of
  also opening the cell editor.
- **The schema cache fences in-flight responses on invalidation**, so a
  pre-invalidation payload can no longer be cached as if it were fresh.
- **A lazy dialog loads its chunk when it is first opened**, not on every tab
  render.
- **The admin and workspace route transition keeps its motion token.** 0.1.95
  dropped `transition={{ ...spatialTransition, opacity: { duration: 0.2 } }}`
  from both route wrappers while rewriting their focus and `inert` handling, so
  the swap ran on Motion's default spring and the fade rode that spring instead
  of a 200 ms tween. Restored on both.
- **The results region animates.** Its `AnimatePresence mode="wait"` wrapped a
  plain `div`, so the wrapper animated nothing and switching result sets — running
  a query, paging — hard-cut.
- **The form `Select`'s listbox has an exit again.** It was the only dropdown in
  the app that vanished in a single frame; `LimitSelect` and
  `FilterHistoryDropdown` both animate out. It now matches them.
- **Tooltips, loading regions and the admin console's banners animate.** Tooltips
  and `LoadingState` appeared and disappeared instantly (the latter behind ~10
  call sites), and the console's notice/error banners and appended connection
  rows popped in.
- **A truncated SQL export is refused.** A `text/plain` export that fails after
  the response headers now ends with `-- Lagun export FAILED: <message>`, and the
  export dialog checks for the `-- Lagun export complete: N rows` trailer before
  it saves, so a dropped stream leaves an error instead of a partial file on
  disk.
- **DDL typed into the editor refreshes the schema tree.** A run whose
  completed statements include `CREATE`/`ALTER`/`DROP`/`RENAME`/`TRUNCATE`
  invalidates and reloads that tab's table list, as the table dialogs already did.
- **Apply merges edits staged while its requests are in flight.** The staged
  changes and insert drafts are cleared synchronously when Apply sends them, so an
  edit made mid-flight is neither dropped nor resurrected by the response.
- **Create Table refreshes the schema even when the dialog was closed first.**
  The success path invalidates the table list and cache whether or not the dialog
  is still mounted.
- **The form `Select` is anchored to its trigger**, not to the label and error
  container around it, opens above the trigger when there is more room there, and
  caps its height to the side it opens on instead of a fixed 320 px that could
  run off-screen.
- **Tab inside a `Select`'s listbox parks focus on the trigger** instead of
  walking out of the portaled listbox, which the enclosing dialog's focus trap
  could not see.
- **A collapsed schema group is `inert`**, so its buttons are not invisible tab
  stops; a dropped table's cached columns are invalidated before a same-name
  table is created; and the tree's context menu clamps to the viewport instead of
  hanging off it.
- **An import that cannot roll back no longer commits what it imported.** A
  rollback that fails or times out closes the connection instead of leaving the
  transaction open for the caller's `SET autocommit=1` to commit.

### Added

- **A progress bar for imports.** A file upload shows a determinate fill driven
  by `XMLHttpRequest.upload.onprogress`, then switches to an indeterminate bar
  while the server imports; a browser without `XMLHttpRequest` falls back to the
  previous upload path. Exports show only the indeterminate bar — the response is
  an unbounded stream with no `Content-Length`, so a percentage would be invented
  rather than measured.

### Changed

- **Export concurrency is bounded** (`LAGUN_EXPORT_MAX_CONCURRENCY`, default 3,
  `LAGUN_EXPORT_QUEUE_TIMEOUT_SECONDS` default 10): a trickling download can no
  longer pin pooled connections past `_EXPORT_MAX_CONCURRENCY`, and excess
  exports answer 503 with `Retry-After` instead of queueing behind them.
- **Every export and import await is bounded by the operation's remaining
  deadline**, not only the loop between batches, and a row write that times out
  discards its pooled connection instead of returning a possibly-busy one.
- **A user's narrowed database list is stored per user** on a shared
  (`connections.yaml`) connection instead of on the one row every allowed user
  sees, so one user narrowing their view no longer changes another's. A
  narrowing that an earlier revision stored on the shared row is not copied into
  anyone's per-user list — those users start at the administrator's ceiling and
  narrow again — because copying the last writer's choice would re-share one
  user's view.
- **The admin connection inventory pages.** `GET /api/v1/admin/connections`
  takes a keyset `limit` (default 100, max 500) and returns `next_cursor`, so the
  payload no longer grows with the number of saved connections; the console grows
  a "Load more" that keeps the pages an operator already loaded across its
  15-second refresh. The overview's connection counts now come from a `COUNT`
  query instead of the page in hand, so they stay correct past one page.
- **`lagun.api.sql_analysis.writes_server_file` was removed.** It had no caller —
  the export path validates server-side file writes inline — and it was the only
  user of its private regex. Anything importing it must inline the check.
- **Bulk scripts are bounded statement by statement**, not only across the run:
  `LAGUN_BULK_MAX_RUNTIME_SECONDS` caps each statement, and `COMMIT`, `ROLLBACK`
  and `SET` get 5 seconds, so a stuck transaction still answers the cancel
  button.
- **A statement that names its own schema no longer needs an in-scope
  `default_db`.** `USE other_db` still fails on a scoped connection, but a fully
  qualified statement is checked against the schemas it actually names.
- **`close_pool` is bounded.** A pool that has not closed within the grace period
  is force-terminated instead of holding the shutdown path open.

## [0.1.95] - 2026-09-23

### Fixed

- **Post-0.1.94 UI regressions.** Fixed across query execution, staged row
  Apply, table dialogs, import/session flows, bookmarks, selects, tooltips,
  menus, focus management, the mobile drawer, admin pagination and the grid find
  layout.

_Backfilled from the release commit; the changelog was introduced with 0.1.94._

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

## [0.1.93] - 2026-09-20

### Changed

- **The login card is unified with ldapgate, torrus and xwing**: one animation
  pair (`login-card-in` 340 ms, `login-error-up` 180 ms), an always-present
  error slot with `role="alert"` and `aria-describedby` on both fields, one
  `:root` palette block instead of scattered literals, and a single
  username-prefill guard. The card now differs from the other three only by
  colours, name, brand mark, title and favicon.
- **Contrast fixes**: the submit hover is `#2e69ec`, which lightens like the
  rest of the theme while keeping the white label at 4.83:1 (was 3.68:1), and
  placeholders and secondary copy are `#86909d` (was 1.93:1 on the input
  surface).

### Dependencies

- **ldapgate >= 0.1.28** is required by the `ldap` extra, tracking the published
  release.

_Backfilled from the release commit; the changelog was introduced with 0.1.94._

## [0.1.92] - 2026-09-19

### Fixed

- **Every dialog now plays its exit animation.** Eight dialogs were mounted
  behind a `{state && <Dialog/>}` guard, which unmounted the component (and the
  `AnimatePresence` it owned) in the same commit as the state flip, so closing
  one hard-cut in a single frame. They now stay mounted with `open` driving
  presence: the cell editor in the grid, the CREATE-statement modal and the
  modify-column dialog in the schema view, both export dialogs, the import
  dialog, the bulk-write confirmation, and the connection form.
- **A fresh open stays clean without remounting**: the export, import and
  bulk-confirm dialogs reset their form state when `open` goes true, so
  reopening never shows the previous run's fields. The destructive-run
  acknowledgement is part of that reset, and the import dialog no longer
  prefetches table lists at mount for tabs that never open it.
- **Four e2e specs that were already failing** were fixed: the grid context menu
  moved off `div.z-[9999]` to `z-popover` with `role="menuitem"`, the
  schema-tree rows now collide with the "New query on <db>" and
  "Bookmark <db>.<table>" buttons, applying changes goes through the
  change-review dialog, the bulk-reject message renders in both a paragraph and
  a `pre`, and the query log's "N rows" entries made the toolbar count
  ambiguous.

### Tests

- **An e2e guard for the dialog-exit class**: `motion.spec` opens a dialog,
  asserts an interpolated exit before the shell detaches, and the suite creates
  and removes its own connection so it no longer depends on whatever is stored
  locally.

_Backfilled from the release commit; the changelog was introduced with 0.1.94._
