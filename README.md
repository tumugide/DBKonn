# DBKonn

A native macOS database client with a retro terminal aesthetic. Connect to PostgreSQL, MySQL, SQLite, or SQL Server, browse schemas and tables, filter rows, edit records inline, and run SQL — all from a single desktop app.

Built with **Tauri 2** (Rust backend) and a **TypeScript** frontend.

## Download (Apple Silicon)

Pre-built for **macOS on Apple Silicon** (M1/M2/M3/M4):

**[Download DBKonn v0.1.0 — Apple Silicon (.dmg)](appbuilds/DBKonn_0.1.0_aarch64.dmg)**

1. Open the `.dmg` and drag **DBKonn** into Applications.
2. On first launch, macOS may block the app because it is not notarized. Open **System Settings → Privacy & Security** and click **Open Anyway**, or right-click the app and choose **Open**.

> Intel Macs and Linux/Windows builds are not included yet. See [Build from source](#build-from-source) below.

## Features

- **Multi-engine support** — PostgreSQL, MySQL/MariaDB, SQLite, Microsoft SQL Server
- **Connection manager** — Save profiles; passwords stored in the macOS Keychain
- **Schema browser** — Databases, schemas, and tables in a sidebar tree
- **Data grid** — Virtual-scrolled table view with sorting and pagination
- **Filters** — Column filters with `=`, `LIKE`, `ILIKE`, `IN`, null checks, and more; apply on demand
- **Record editor** — Right panel to view and edit rows with commit/rollback
- **Type-aware editing** — Enum dropdowns, date pickers, timestamp `NOW()`, JSON fields
- **SQL editor** — CodeMirror 6 with dialect-aware syntax highlighting
- **CSV export**
- **`dbctl` CLI** — Backup and restore via `pg_dump`, `mysqldump`, etc.

## Project layout

```
DBKonn/
├── app/              # Tauri desktop app (TypeScript + Rust shell)
│   ├── src/          # Frontend UI
│   └── src-tauri/    # Tauri commands and IPC
├── core/             # Shared Rust database layer (dbkonn-core)
├── cli/              # dbctl command-line tool
└── appbuilds/        # Pre-built macOS installers
```

## Build from source

### Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| [Rust](https://rustup.rs/) | stable | `rustup default stable` |
| [Bun](https://bun.sh/) | latest | Used for the frontend build (`bun` or `npm` works) |
| Xcode Command Line Tools | — | `xcode-select --install` on macOS |

Optional for integration tests:

- Docker (Postgres/SQLite test containers)

### Development (hot reload)

```bash
# Install frontend dependencies
cd app
bun install

# Start Tauri dev server (frontend + Rust backend)
bunx tauri dev
```

This opens the app connected to your dev deployment. Use the in-app connection manager to add database profiles.

### Production build (macOS Apple Silicon)

```bash
cd app
bun install
bunx tauri build --target aarch64-apple-darwin
```

Artifacts are written to:

```
target/aarch64-apple-darwin/release/bundle/
├── macos/DBKonn.app
└── dmg/DBKonn_0.1.0_aarch64.dmg
```

Copy the `.dmg` into `appbuilds/` if you want to ship it from the repo:

```bash
cp ../target/aarch64-apple-darwin/release/bundle/dmg/DBKonn_0.1.0_aarch64.dmg ../appbuilds/
```

### Build the CLI (`dbctl`)

```bash
cargo build --release -p dbctl
# Binary: target/release/dbctl
```

```bash
dbctl list
dbctl backup --conn "my-postgres" --out ./backup.sql
dbctl restore --conn "my-postgres" --in ./backup.sql
```

### Run core library tests

```bash
cargo test -p dbkonn-core
```

## Connection storage

Saved connections are stored at:

```
~/Library/Application Support/DBKonn/connections.json
```

Passwords are kept in the **macOS Keychain**, not in the JSON file.

## Tech stack

| Layer | Technology |
|-------|------------|
| Desktop shell | Tauri 2 |
| Frontend | TypeScript, Vite 6, CodeMirror 6 |
| Backend | Rust (`dbkonn-core`) |
| Postgres / MySQL / SQLite | sqlx |
| SQL Server | tiberius |
| SQL validation | sqlparser |

## License

MIT
