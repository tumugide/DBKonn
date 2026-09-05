# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

DBKonn is a native macOS database client (Tauri 2 + TypeScript frontend) for PostgreSQL, MySQL/MariaDB, SQLite, and SQL Server. It also ships a `dbctl` CLI for backup/restore. Currently macOS / Apple Silicon only.

## Commands

All frontend work uses **Bun** (`app/bun.lock` is authoritative; the stray `app/package-lock.json` is stale — ignore it).

| Task | Command |
|------|---------|
| Run the app (frontend + Rust, hot reload) | `cd app && bun install && bunx tauri dev` |
| Frontend only (Vite, port 5173, strict) | `cd app && bun run dev` |
| Typecheck + frontend build | `cd app && bun run build` (`tsc && vite build`) |
| Production app bundle | `cd app && bunx tauri build --target aarch64-apple-darwin` |
| Production bundle *with updater* (CI-style) | `cd app/src-tauri && TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/dbkonn.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" cargo tauri build --target aarch64-apple-darwin --config tauri.updater.conf.json` |
| Build everything (Rust) | `cargo build` |
| Core library tests | `cargo test -p dbkonn-core` |
| One Rust test | `cargo test -p dbkonn-core <test_name>` (e.g. `quotes_identifiers_per_dialect`) |
| DB integration tests (opt-in) | `TEST_PG_HOST=localhost TEST_PG_USER=postgres cargo test -p dbkonn-core --test pg_integration` |
| Build the CLI | `cargo build --release -p dbctl` → `target/release/dbctl` |

There is **no frontend test runner and no ESLint/Prettier**. The "lint" gate is `tsc` (run via `bun run build`); `tsconfig.json` has `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`. Frontend build target is `safari13` (macOS WKWebView) — avoid very new JS APIs.

Integration tests (`core/tests/*_integration.rs`) silently no-op unless their `TEST_*` env vars point at a live database.

## Architecture

Cargo workspace, three crates, one shared version (`Cargo.toml` `[workspace.package]`, stamped by CI):

- **`core/`** (`dbkonn-core`) — engine-agnostic database layer, no Tauri dependency.
- **`app/src-tauri/`** (`dbkonn-app`) — the desktop shell: Tauri commands, app state, connection storage, native menu, updater.
- **`cli/`** (`dbctl`) — standalone backup/restore tool that reads the same `connections.json` + Keychain.

### Backend: drivers

`core/src/drivers/mod.rs` defines the `DbConnection` async trait (test/list/describe/execute/paginate/count/close). One impl per engine: `pg.rs`, `mysql.rs`, `sqlite.rs` (all sqlx), `mssql.rs` (tiberius). `drivers::connect(&ConnectionConfig)` is the factory returning `Box<dyn DbConnection>`. To add engine behavior, change the trait + all four impls.

### Frontend ↔ backend boundary

Tauri IPC. Every command lives in `app/src-tauri/src/commands.rs` and must also be listed in the `invoke_handler!` macro in `app/src-tauri/src/lib.rs`. The frontend calls them **only** through `app/src/lib/ipc.ts`, whose TypeScript interfaces hand-mirror the Rust structs in `core/src/query.rs` and `core/src/connection.rs` — **keep the two sides in sync** when changing any wire type.

### Connection pooling / locking

`AppState.connections` is `Arc<RwLock<HashMap<ConnectionId, Arc<dyn DbConnection>>>>`. Handlers use `driver_for()` to clone the `Arc<dyn DbConnection>` out **under a brief read lock, then drop the lock** before the DB round-trip. Never hold the map lock across a query — doing so serializes every connection behind the slowest query. `connect_db`/`disconnect_db` call `driver.close()` off-lock so server-side connections are released promptly.

### Connection storage & secrets

- Config: `~/Library/Application Support/DBKonn/connections.json` — written atomically (temp file + rename) and serialized through a process-wide `WRITE_LOCK`. A parse failure is surfaced, never swallowed.
- Passwords: macOS Keychain via the `keyring` crate — service `"DBKonn"`, account = connection `id`. Never written to the JSON.
- Keychain reads go through `get_password_async` (`spawn_blocking` + 15s timeout) because Keychain can block on a native "Allow/Deny" dialog (common after a rebuild changes the code signature), which otherwise looks like an infinite "Connecting…" spinner.

### SQL string-building & injection model (read before touching query generation)

DBKonn assembles a lot of SQL by string interpolation (schema browse, table paging/sorting, filters, the row editor). The guardrails:

1. **Identifiers and literals** must always pass through the dialect-aware quoters: `core/src/ident.rs` `quote_ident` / `quote_literal` on the Rust side, `app/src/lib/sqlQuote.ts` `quoteIdent` / `quoteValue` on the frontend. These two implementations must stay behaviorally identical (MySQL also escapes `\`, MSSQL uses `[ ]`, etc.).
2. **Filter/paging `where_clause`** crosses IPC as a raw string. Every driver calls `validator::validate_where_clause` before interpolating it — it wraps the fragment in `SELECT 1 FROM t WHERE <clause>`, parses with the engine's `sqlparser` dialect, and rejects anything that isn't exactly one statement (blocks stacked `;` — an RCE vector on the MSSQL `simple_query` path).
3. **`CREATE DATABASE`** names go through `validate_db_name` (drivers/mod.rs) — DDL identifiers can't be bind-parameterized, so the restrictive charset *is* the guard.
4. **Row editor `UPDATE`/`DELETE`** SQL is built on the **frontend** (`app/src/lib/rowEdit.ts`) and run via `execute_query`. The WHERE clause uses primary-key columns when present, otherwise every column; `affected_rows === 0` is treated as an optimistic-concurrency conflict and shown to the user.

`validate_sql` (SQL editor) is advisory only — it drives editor error markers, it does not gate execution.

### Other backend specifics

- `RowValue` (`core/src/query.rs`) has a custom `Serialize`: `i64` outside JS safe-integer range is emitted as a **string** so BIGINT/oid values aren't silently rounded in the webview.
- `statement_returns_rows()` decides whether `execute_query` fetches a result set or reports an affected-row count — it strips leading comments and understands `RETURNING`, `CALL`, `VALUES`, `PRAGMA`, etc.
- Native macOS menu bar (Theme + Query submenus) is built in `app/src-tauri/src/lib.rs`, kept in sync with the webview via the `sync_theme_menu` / `sync_query_menu` commands and `menu:*` events. All of this is `#[cfg(target_os = "macos")]`.
- Updater (`updater.rs`): the "Check for Updates" menu item uses `tauri-plugin-updater` to check the GitHub release manifest, then downloads/verifies/installs the signed `.app.tar.gz` in place and relaunches. It is only enabled in CI-style release builds: the updater config (`plugins.updater.pubkey` + endpoints) and `bundle.createUpdaterArtifacts` live in **`app/src-tauri/tauri.updater.conf.json`**, which is merged via `--config` **only in CI** so local `tauri build` runs never demand the signing key. In dev builds the menu item reports that the updater isn't configured (no chance of a password prompt).

### Frontend structure

No framework. `app/src/lib/store.ts` is a hand-rolled `Signal<T>` reactive store; `app/src/main.ts` (~2400 lines) is the whole app shell (connection rail, sidebar schema tree, tab strip, content area). `app/src/components/*.ts` are plain classes — each has a `.destroy()` that **must** be called on teardown or its store/theme subscriptions and CodeMirror views leak (see `destroyActiveTabComponents`).

Session/tab model:
- A **`ConnSession`** is one open (connected) database; several can be open at once. Its `id` is stable; its `connId` is the live IPC handle and **changes** when `switchDatabase` disconnects and reconnects underneath.
- Tabs are `TableTab | QueryTab`. Each session owns its tab strip; the focused session's strip is mirrored into the top-level `openTabs` / `activeTab` signals.
- Open sessions + tabs are persisted to `localStorage` (`app/src/lib/session.ts`) and restored on launch.

Reliability patterns already in place (preserve them):
- Browse/metadata IPC calls are wrapped in `withTimeout` (60s, `ipc.ts`) — a Tauri `invoke` that never settles otherwise wedges the grid loader's `finally` and leaves the loading overlay stuck.
- `loadTableData` uses a monotonic request id: only the latest in-flight fetch may paint the grid, and it always owns clearing the spinner.
- The 30s background `refreshSchemaTree` must not apply results to a connection the user has since switched away from (guarded by session-id checks).

## Release process

`.github/workflows/release.yml` runs on every push to `main`: CI derives the next patch version from the latest `v*` git tag, stamps it into `Cargo.toml`, `app/src-tauri/tauri.conf.json`, and `app/package.json` **within the CI workspace only** (nothing is committed back), builds the Apple-Silicon bundle **with the updater config merged** (`--config tauri.updater.conf.json`), signs the update artifacts with the `TAURI_SIGNING_PRIVATE_KEY` secret, generates `latest.json`, and publishes/updates the `v<version>` GitHub release with the `.dmg`, `.app.tar.gz`, `.app.tar.gz.sig`, and `latest.json`. The committed version fields are just a floor — the real version lives in git tags and releases. Windows/Linux build jobs exist but are commented out.

## Update signing

- Keypair lives at `~/.tauri/dbkonn.key` (+ `.key.pub`), generated with `cargo tauri signer generate --ci -w ~/.tauri/dbkonn.key`. **Losing it breaks updates for installed apps forever**; back it up.
- The *public* half is committed in `app/src-tauri/tauri.updater.conf.json` (base64 of the `.key.pub` text, including the `untrusted comment:` header/newline — it is intentionally *not* the raw text). The *private* key must be set as the GitHub Actions repo secrets `TAURI_SIGNING_PRIVATE_KEY` (the file content) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty — the generated key has no password). Both env vars are exported during the CI build step; passing an empty password explicitly keeps `tauri build` from prompting for a TTY.

## Notes

- `app/src-tauri/gen/` is generated and gitignored.
- Two `index.html` files: `app/index.html` is the real Vite entry point; the repo-root `index.html` is a standalone marketing/landing page, unrelated to the app build.
- `dbctl` shells out to `pg_dump` / `pg_restore` / `mysqldump` / `mysql` / `sqlcmd` and passes passwords via environment variables (`PGPASSWORD`, `MYSQL_PWD`, `SQLCMDPASSWORD`), never on the command line.
