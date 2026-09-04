import "./styles/global.css";
import { listen } from "@tauri-apps/api/event";
import { ipc, type ConnectionConfig, type ColumnInfo, type IndexInfo } from "./lib/ipc";
import {
  appState,
  type ThemeType,
  type ConnSession,
  type AppTab,
  type TableTab,
  type QueryTab,
  type TableState,
  THEMES,
  CONNECTION_COLORS,
} from "./lib/store";
import { DataGrid } from "./components/DataGrid";
import { FilterBar } from "./components/FilterBar";
import { SqlEditor } from "./components/SqlEditor";
import { RecordPanel } from "./components/RecordPanel";
import { showConnectionModal } from "./components/ConnectionModal";
import { showCreateDatabaseModal } from "./components/CreateDatabaseModal";
import { showStructureModal } from "./components/StructureModal";
import { escapeHtml as esc } from "./lib/escape";
import { wireModalDismissal } from "./lib/modal";
import { createExportButton } from "./components/ExportMenu";
import { showContextMenu } from "./components/ContextMenu";
import { cloneRowValue, buildDeleteSql } from "./lib/rowEdit";
import type { RowValue } from "./lib/ipc";
import { saveExport, formatMeta, MAX_EXPORT_ROWS, type ExportFormat } from "./lib/export";
import {
  saveSession,
  loadSession,
  clearSession,
  type StoredConnSession,
} from "./lib/session";

// ── Theme application ─────────────────────────────────────────────────────────

function applyTheme(theme: ThemeType) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("dbkonn-theme", theme);
  const el = document.getElementById("theme-label");
  if (el) el.textContent = THEMES[theme].label;
}

function loadSavedTheme(): ThemeType {
  const saved = localStorage.getItem("dbkonn-theme") as ThemeType | null;
  if (saved && THEMES[saved]) return saved;
  return "bios";
}

// ── Appearance modal ──────────────────────────────────────────────────────────

function showAppearanceModal() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  const currentTheme = appState.theme.value;
  const themeKeys = Object.keys(THEMES) as ThemeType[];

  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">Appearance</div>
      <div class="modal-body">
        <p style="font-size:11px;color:var(--text-muted);margin-bottom:12px;">
          Select a theme
        </p>
        <div class="theme-grid">
          ${themeKeys.map((key) => {
            const meta = THEMES[key];
            const active = key === currentTheme ? " active" : "";
            return `<button class="theme-option${active}" data-theme-key="${key}">
              <span class="dot" style="background:var(--accent)"></span>
              ${meta.label}
              ${active ? '<span class="current-badge">Current</span>' : ""}
            </button>`;
          }).join("")}
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="am-close">Close</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelectorAll(".theme-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = (btn as HTMLElement).dataset["themeKey"] as ThemeType;
      if (key === appState.theme.value) return;
      overlay.remove();
      appState.theme.set(key);
    });
  });

  overlay.querySelector("#am-close")!.addEventListener("click", () => overlay.remove());
  wireModalDismissal(overlay, () => overlay.remove());
}

// ── App Shell ─────────────────────────────────────────────────────────────────

const app = document.getElementById("app")!;

app.innerHTML = `
  <div class="app-layout">
    <aside class="conn-rail" id="conn-rail"></aside>
    <aside class="sidebar" id="sidebar"></aside>
    <div class="main-area">
      <div class="table-tab-strip" id="table-tabs-list"></div>
      <div id="tab-content-area" style="flex:1;overflow:hidden;display:flex;flex-direction:column;"></div>
    </div>
  </div>
  <div class="status-bar">
    <div class="status-dot" id="status-dot"></div>
    <span id="status-text">Ready</span>
    <span id="theme-label" style="margin-left:auto;cursor:pointer;color:var(--text-muted);" title="Click to change theme"></span>
  </div>
`;

// ── Element refs ──────────────────────────────────────────────────────────────
const connRailEl = document.getElementById("conn-rail")!;
const sidebarEl = document.getElementById("sidebar")!;
const mainContent = document.getElementById("tab-content-area")!;
const statusText = document.getElementById("status-text")!;
const statusDot = document.getElementById("status-dot")!;
const themeLabel = document.getElementById("theme-label")!;
const tabStripEl = document.getElementById("table-tabs-list")!;

appState.status.subscribe((s) => {
  statusText.textContent = s;
});

// ── Theme: apply on boot, listen for changes ──────────────────────────────────
const savedTheme = loadSavedTheme();
appState.theme.set(savedTheme);
applyTheme(savedTheme);
appState.theme.subscribe(applyTheme);

// Keep the native "Theme" menu (macOS menu bar) checkmarks in sync with
// whatever theme is active, whichever side changed it.
appState.theme.subscribe((theme) => {
  ipc.syncThemeMenu(theme).catch(() => {});
});
ipc.syncThemeMenu(savedTheme).catch(() => {});

// Selecting a theme from the native menu applies it here.
listen<string>("menu:set-theme", (event) => {
  const theme = event.payload as ThemeType;
  if (THEMES[theme] && theme !== appState.theme.value) {
    appState.theme.set(theme);
  }
});

themeLabel.addEventListener("click", showAppearanceModal);

// Keep the native "Query" menu (macOS menu bar) in sync with the query tabs
// open on the active connection, so it can offer "New Query" plus a list of
// the other query tabs to jump to.
function syncQueryMenuFromState() {
  const ac = appState.activeConn.value;
  if (!ac) {
    ipc.syncQueryMenu([], null).catch(() => {});
    return;
  }
  const tabs = appState.openTabs.value
    .filter((t): t is QueryTab => t.kind === "query" && t.connId === ac.connId)
    .map((t) => ({ id: t.id, title: t.title, number: Number(t.title.match(/\d+/)?.[0] ?? 0) }))
    .sort((a, b) => a.number - b.number)
    .map(({ id, title }) => ({ id, title }));
  ipc.syncQueryMenu(tabs, appState.activeTab.value).catch(() => {});
}
appState.openTabs.subscribe(syncQueryMenuFromState);
appState.activeTab.subscribe(syncQueryMenuFromState);
appState.activeConnId.subscribe(syncQueryMenuFromState);
syncQueryMenuFromState();

// "New Query" from the native menu — same behavior as the tab-strip "+" button.
listen("menu:new-query", () => openQueryTab());

// Selecting a query tab from the native menu switches to it.
listen<string>("menu:switch-query-tab", (event) => switchToTab(event.payload));

// ── Sidebar ───────────────────────────────────────────────────────────────────

function renderSidebar() {
  renderConnRail();

  const ac = appState.activeConn.value;
  const buf: string[] = [];

  if (ac) {
    // ── Connected mode ─────────────────────────────────────────────────────
    buf.push(`
      <div class="sidebar-header connected" style="--conn-color:${connColor(ac.config)}">
        <span class="sidebar-header-name" title="${esc(ac.config.name)}">${esc(ac.config.name)}</span>
        <div class="sidebar-header-actions">
          <button class="btn-icon" id="sb-refresh-tree" title="Refresh database (schemas and tables)" aria-label="Refresh database (schemas and tables)">⟳</button>
          <button class="btn-icon danger" id="sb-disconnect" title="Disconnect">Quit</button>
        </div>
      </div>
      <div class="db-controls">
    `);

    // Database dropdown — for all engines that have a DB concept
    if (ac.config.engine !== "sqlite") {
      const dbs = ac.databases
        .map((db) => {
          const sel = db === ac.selectedDatabase ? " selected" : "";
          return `<option value="${esc(db)}"${sel}>${esc(db)}</option>`;
        })
        .join("");
      buf.push(`
        <div class="db-control-row">
          <label>DB</label>
          <select id="sb-db-select">${dbs}</select>
          <button class="btn-icon" id="sb-new-db" title="Create database">+</button>
        </div>
      `);
    }

    // Schema dropdown — Postgres and MSSQL have separate schemas
    if (ac.config.engine === "postgres" || ac.config.engine === "mssql") {
      const schemas = ac.schemas
        .map((s) => {
          const sel = s.name === ac.selectedSchema ? " selected" : "";
          return `<option value="${esc(s.name)}"${sel}>${esc(s.name)}</option>`;
        })
        .join("");
      buf.push(`
        <div class="db-control-row">
          <label>Schema</label>
          <select id="sb-schema-select">${schemas}</select>
        </div>
      `);
    }

    buf.push(`</div>`);

    // Table tree
    buf.push(`
      <div class="tree-header">
        <span>Tables <span class="tree-count" id="sb-tree-count">${ac.tables.length}</span></span>
      </div>
      <div style="flex:1;overflow-y:auto;" id="sb-table-tree"></div>
    `);
  } else {
    // ── Disconnected mode ──────────────────────────────────────────────────
    buf.push(`
      <div class="sidebar-header">
        <span>Connections</span>
        <button class="btn-icon" id="sb-new-conn" title="New connection">+</button>
      </div>
      <div class="conn-list" id="sb-conn-list"></div>
    `);
  }

  sidebarEl.innerHTML = buf.join("");

  // ── Wire up events ────────────────────────────────────────────────────────
  if (ac) {
    document
      .getElementById("sb-disconnect")
      ?.addEventListener("click", () => disconnectSession(ac.id));

    document.getElementById("sb-db-select")?.addEventListener("change", (e) => {
      const db = (e.target as HTMLSelectElement).value;
      switchDatabase(db);
    });

    document.getElementById("sb-new-db")?.addEventListener("click", () => {
      showCreateDatabaseModal(ac.connId, (newName) => {
        appState.activeConn.set({ ...ac, databases: [...ac.databases, newName] });
        switchDatabase(newName);
      });
    });

    document
      .getElementById("sb-schema-select")
      ?.addEventListener("change", (e) => {
        const schema = (e.target as HTMLSelectElement).value;
        switchSchema(schema);
      });

    renderTableTree(ac);

    document
      .getElementById("sb-refresh-tree")
      ?.addEventListener("click", () => void refreshSchemaTree());
  } else {
    document.getElementById("sb-new-conn")?.addEventListener("click", () => {
      showConnectionModal(undefined, () => renderSidebar());
    });
    renderConnList();
  }
}

// Re-syncs which sidebar tree-item shows as "active" for any code path that
// changes selectedTable outside of a full renderSidebar() rebuild, without
// touching the DB/schema dropdowns or rebinding listeners.
function updateTreeActiveState() {
  const ac = appState.activeConn.value;
  sidebarEl.querySelectorAll<HTMLElement>(".tree-item").forEach((el) => {
    el.classList.toggle("active", el.dataset["table"] === ac?.selectedTable);
  });
}

function tableIcon(type: string | undefined): string {
  switch (type) {
    case "view":
      return "◇";
    case "materialized view":
      return "◈";
    case "foreign table":
      return "⊟";
    default:
      return "▦";
  }
}

// Compact row-count estimate for the sidebar (1.2k, 3M). Estimates only —
// from pg reltuples / MySQL TABLE_ROWS, never an exact COUNT.
function compactCount(n: number | undefined): string {
  if (n == null || n < 0) return "";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

// Identity of the currently-rendered table list, so a background refresh that
// returns the same tables can skip the DOM rebuild entirely (see below).
function tableListSignature(ac: ConnSession): string {
  return ac.tables
    .map((t) => `${t.name} ${t.table_type ?? ""} ${t.row_count_estimate ?? ""}`)
    .join("");
}

// Rebuilds just the table-list container, without touching the DB/schema
// dropdowns — used by both the initial renderSidebar() build and
// refreshSchemaTree(), so there's one source of truth for the tree-item markup.
//
// The rebuild is skipped when the table list is unchanged. The 30s background
// refresh used to blow away and recreate every row unconditionally, which
// reset the tree's scroll position to the top and reflowed the list under a
// stationary pointer — so a click landed on whatever table had shifted under
// the cursor and opened it as a brand-new tab, over and over.
function renderTableTree(ac: ConnSession) {
  const countEl = document.getElementById("sb-tree-count");
  if (countEl) countEl.textContent = String(ac.tables.length);

  const treeEl = document.getElementById("sb-table-tree");
  if (!treeEl) return;

  // Click handling is delegated to the container and bound once, so rebuilding
  // rows never re-attaches (or orphans) per-row listeners.
  if (!treeEl.dataset["delegated"]) {
    treeEl.dataset["delegated"] = "1";
    treeEl.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement | null)?.closest<HTMLElement>(".tree-item");
      const tableName = item?.dataset["table"];
      if (!tableName) return;
      openOrCreateTableTab(tableName, appState.activeConn.value?.selectedSchema);
    });
  }

  const signature = tableListSignature(ac);
  if (treeEl.dataset["signature"] === signature && treeEl.childElementCount > 0) {
    updateTreeActiveState();
    return;
  }

  const prevScroll = treeEl.scrollTop;
  treeEl.innerHTML = ac.tables
    .map((t) => {
      const active = t.name === ac.selectedTable ? " active" : "";
      const count = compactCount(t.row_count_estimate);
      const typeLabel = t.table_type && t.table_type !== "table" ? ` · ${t.table_type}` : "";
      return `<div class="tree-item${active}" data-table="${esc(t.name)}" title="${esc(t.name)}${typeLabel}${count ? ` · ~${t.row_count_estimate} rows` : ""}">
        <span class="tree-item-icon">${tableIcon(t.table_type)}</span>
        <span class="tree-item-name">${esc(t.name)}</span>
        ${count ? `<span class="tree-item-count">${count}</span>` : ""}
      </div>`;
    })
    .join("");
  treeEl.dataset["signature"] = signature;
  treeEl.scrollTop = prevScroll;
}

function renderConnList() {
  const listEl = document.getElementById("sb-conn-list");
  if (!listEl) return;
  const conns = appState.connections.value;
  const ac = appState.activeConn.value;

  listEl.innerHTML = "";
  if (conns.length === 0) {
    listEl.innerHTML = `<div style="padding:12px 8px;color:var(--text-faint);font-size:11px;">
      No connections yet.<br>Press + to add one.
    </div>`;
    return;
  }

  conns.forEach((cfg) => {
    const item = document.createElement("div");
    item.className = "conn-item" + (ac?.config.id === cfg.id ? " active" : "");
    item.innerHTML = `
      <span class="conn-color-dot" style="background:${connColor(cfg)}"></span>
      <span class="conn-engine">${cfg.engine.slice(0, 2).toUpperCase()}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(cfg.name)}</span>`;
    item.addEventListener("click", () => connectToDb(cfg));
    listEl.appendChild(item);
  });
}

// ── Connection rail (avatar switcher for open connections) ─────────────────────

function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

// Fallback color for connections without a user-assigned color (see
// ConnectionModal's color picker). Deterministic per saved connection id
// (not per session) so the same connection always gets the same color.
function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 55%, 42%)`;
}

// The connection color is written straight into inline `style="..."` — only
// allow values from the curated palette; fall back to the deterministic
// avatar color for anything else.
function connColor(cfg: { id: string; color?: string }): string {
  return cfg.color && CONNECTION_COLORS.includes(cfg.color)
    ? cfg.color
    : avatarColor(cfg.id);
}

function renderConnRail() {
  const sessions = appState.connSessions.value;
  const activeId = appState.activeConnId.value;

  connRailEl.innerHTML = "";
  connRailEl.style.display = sessions.length === 0 ? "none" : "flex";
  if (sessions.length === 0) return;

  sessions.forEach((s) => {
    const btn = document.createElement("button");
    btn.className = `conn-avatar${s.id === activeId ? " active" : ""}`;
    btn.style.background = connColor(s.config);
    btn.title = s.config.name;
    btn.textContent = initialsFor(s.config.name);
    btn.onclick = () => switchToConnSession(s.id);
    btn.oncontextmenu = (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: "Disconnect", onSelect: () => disconnectSession(s.id) },
        {
          label: "Disconnect Others",
          onSelect: () => disconnectOtherSessions(s.id),
          disabled: sessions.length <= 1,
        },
        {
          label: "Disconnect All",
          onSelect: () => disconnectAllSessions(),
          separatorBefore: true,
          danger: true,
        },
      ]);
    };

    const closeBtn = document.createElement("span");
    closeBtn.className = "conn-avatar-close";
    closeBtn.innerHTML = "&#10005;";
    closeBtn.title = "Disconnect";
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      disconnectSession(s.id);
    };
    btn.appendChild(closeBtn);

    connRailEl.appendChild(btn);
  });

  const addBtn = document.createElement("button");
  addBtn.className = "conn-rail-add";
  addBtn.innerHTML = "+";
  addBtn.title = "Open another connection";
  addBtn.onclick = () => {
    tabStripEl.style.display = "none";
    showConnectionsScreen();
  };
  connRailEl.appendChild(addBtn);
}

// ── Database / Schema switching ───────────────────────────────────────────────

let switchDatabaseInFlight = false;

async function switchDatabase(dbName: string) {
  const ac = appState.activeConn.value;
  if (!ac || ac.selectedDatabase === dbName) return;

  // Switching database disconnects/reconnects and drops every open tab —
  // don't do that silently on top of an unsaved row edit. Re-render the
  // sidebar so the DB dropdown snaps back to the current database if the
  // user cancels.
  if (!confirmDiscardIfDirty()) {
    renderSidebar();
    return;
  }
  if (switchDatabaseInFlight) return;
  switchDatabaseInFlight = true;

  appState.status.set(`Switching to database: ${dbName}…`);

  try {
    // For MySQL, "database" IS the schema — switch via new connection
    // For Postgres/MSSQL, reconnect to the new database
    await ipc.disconnectDb(ac.connId);

    const newConfig = { ...ac.config, database: dbName };
    const newConnId = await ipc.connectDb(newConfig);

    const [schemas, tables] = await Promise.all([
      ipc.listSchemas(newConnId),
      ipc.listTables(newConnId),
    ]);

    const defaultSchema =
      schemas.find((s) => s.name === "public" || s.name === "dbo")?.name ??
      schemas[0]?.name;

    // Keep the databases list, just switch which one is active
    appState.activeConn.set({
      ...ac,
      connId: newConnId,
      config: newConfig,
      selectedDatabase: dbName,
      schemas,
      selectedSchema: defaultSchema,
      tables,
      selectedTable: undefined,
    });

    statusDot.className = "status-dot connected";
    appState.status.set(`Connected: ${newConfig.name} / ${dbName}`);
    // The connection was replaced — existing tabs reference the old connId
    resetTabsAndLiveState();
    renderSidebar();
    openQueryTab();
  } catch (e) {
    appState.status.set(`Error: ${e}`);
    statusDot.className = "status-dot error";
  } finally {
    switchDatabaseInFlight = false;
  }
}

async function switchSchema(schemaName: string) {
  const ac = appState.activeConn.value;
  if (!ac || ac.selectedSchema === schemaName) return;

  appState.status.set(`Loading schema: ${schemaName}…`);

  try {
    const tables = await ipc.listTables(ac.connId, schemaName);
    appState.activeConn.set({
      ...ac,
      selectedSchema: schemaName,
      tables,
      selectedTable: undefined,
    });

    appState.status.set(`Schema: ${schemaName} (${tables.length} tables)`);
    renderSidebar();
  } catch (e) {
    appState.status.set(`Error: ${e}`);
  }
}

// ── Schema refresh (manual + background) ────────────────────────────────────
// Re-fetches databases/schemas/tables for the focused connection in place,
// without disrupting open tabs or in-progress edits — mirrors the re-fetch
// pattern switchSchema() already uses, just without the reconnect.

// Keyed by session id, not a single flag — refreshes for different open
// connections must not block each other (see staleness check below for why
// that matters).
const schemaRefreshInFlight = new Set<string>();

async function refreshSchemaTree(opts?: { silent?: boolean }) {
  const ac = appState.activeConn.value;
  if (!ac) return;
  const sessionId = ac.id;
  if (schemaRefreshInFlight.has(sessionId)) return;
  if (document.querySelector(".modal-overlay")) return;

  schemaRefreshInFlight.add(sessionId);
  const refreshBtn = document.getElementById("sb-refresh-tree");
  if (!opts?.silent) refreshBtn?.classList.add("spinning");

  try {
    // Resolve databases/schemas first, THEN list tables for the *effective*
    // schema. Fetching tables up-front with a possibly-stale
    // `ac.selectedSchema` (and, on MySQL, the schema instead of the database)
    // returned an empty list that then blanked the whole table tree.
    const [databases, schemas] = await Promise.all([
      ipc.listDatabases(ac.connId).catch(() => ac.databases),
      ipc.listSchemas(ac.connId).catch(() => ac.schemas),
    ]);

    const selectedSchema = schemas.some((s) => s.name === ac.selectedSchema)
      ? ac.selectedSchema
      : (schemas.find((s) => s.name === "public" || s.name === "dbo")?.name ??
        schemas[0]?.name ??
        ac.selectedSchema);

    // MySQL browses tables by database, not by information_schema schema.
    const tableScope =
      ac.config.engine === "mysql"
        ? (ac.selectedDatabase ?? selectedSchema)
        : selectedSchema;

    const tables = await ipc
      .listTables(ac.connId, tableScope)
      .catch(() => ac.tables);

    const selectedTable = tables.some((t) => t.name === ac.selectedTable) ? ac.selectedTable : undefined;

    const updated = { ...ac, databases, schemas, selectedSchema, tables, selectedTable };

    // Keep the fetched data cached on the session even if the user has
    // since switched away, so it's fresh whenever they switch back to it.
    appState.connSessions.set(
      appState.connSessions.value.map((s) => (s.id === sessionId ? updated : s)),
    );

    // But if focus has moved to a different connection while this fetch was
    // in flight, do NOT touch the live UI/activeConn — this fetch is for a
    // connection that's no longer on screen, and applying it here would
    // silently replace whatever connection the user is now looking at with
    // this one's tables (this was the root cause of tables from one
    // connection "flashing over" another after a few seconds).
    if (appState.activeConn.value?.id !== sessionId) return;

    appState.activeConn.set(updated);

    // If the connected sidebar isn't currently mounted (e.g. this ran right
    // after a focus switch, before renderSidebar), rebuild it wholesale
    // instead of no-op'ing on the missing tree container.
    if (!document.getElementById("sb-table-tree")) {
      renderSidebar();
      if (!opts?.silent) appState.status.set("Schema refreshed");
      return;
    }

    renderTableTree(updated);

    const dbSelect = document.getElementById("sb-db-select") as HTMLSelectElement | null;
    if (dbSelect && document.activeElement !== dbSelect) {
      dbSelect.innerHTML = databases
        .map((db) => `<option value="${esc(db)}"${db === updated.selectedDatabase ? " selected" : ""}>${esc(db)}</option>`)
        .join("");
    }
    const schemaSelect = document.getElementById("sb-schema-select") as HTMLSelectElement | null;
    if (schemaSelect && document.activeElement !== schemaSelect) {
      schemaSelect.innerHTML = schemas
        .map((s) => `<option value="${esc(s.name)}"${s.name === selectedSchema ? " selected" : ""}>${esc(s.name)}</option>`)
        .join("");
    }

    if (!opts?.silent) appState.status.set("Schema refreshed");
  } catch (e) {
    if (!opts?.silent) appState.status.set(`Error: ${e}`);
    else console.warn("Auto-refresh failed:", e);
  } finally {
    schemaRefreshInFlight.delete(sessionId);
    refreshBtn?.classList.remove("spinning");
  }
}

const AUTO_REFRESH_INTERVAL_MS = 30_000;
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

function stopAutoRefresh() {
  if (autoRefreshTimer !== null) clearInterval(autoRefreshTimer);
  autoRefreshTimer = null;
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (document.hidden || !appState.activeConn.value) return;
  autoRefreshTimer = setInterval(() => {
    if (!document.hidden) void refreshSchemaTree({ silent: true });
  }, AUTO_REFRESH_INTERVAL_MS);
}

document.addEventListener("visibilitychange", () => {
  document.hidden ? stopAutoRefresh() : startAutoRefresh();
});
window.addEventListener("focus", startAutoRefresh);
window.addEventListener("blur", stopAutoRefresh);

// F5 — advertised in the grid toolbar tooltip but previously unhandled.
// Reloads the active table tab's rows in place, or refreshes the schema
// tree when the active tab isn't a table.
window.addEventListener("keydown", (e) => {
  if (e.key !== "F5" || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  const activeId = appState.activeTab.value;
  const tab = appState.openTabs.value.find((t) => t.id === activeId);
  if (tab?.kind === "table" && activeTableReload) {
    if (!confirmDiscardIfDirty()) return;
    clearRecordSelection();
    activeTableReload();
  } else {
    void refreshSchemaTree();
  }
});

// Disconnects a single connection session — the focused one (from the
// sidebar "Quit" button) or a background one (from the rail's hover-×) —
// leaving every other open connection untouched.
async function disconnectSession(id: string) {
  const list = appState.connSessions.value;
  const session = list.find((s) => s.id === id);
  if (!session) return;

  const isFocused = id === appState.activeConnId.value;
  if (isFocused && appState.selectedRecord.value?.dirty) {
    if (!confirm("Discard unsaved changes and disconnect?")) return;
  }

  try {
    await ipc.disconnectDb(session.connId);
  } catch {
    /* ignore */
  }

  const remaining = list.filter((s) => s.id !== id);
  appState.connSessions.set(remaining);

  if (isFocused) {
    if (remaining.length > 0) {
      switchToConnSession(remaining[0]!.id);
    } else {
      appState.activeConnId.set(null);
      appState.activeConn.set(null);
      resetTabsAndLiveState();
      statusDot.className = "status-dot";
      appState.status.set("Disconnected");
      stopAutoRefresh();
      renderSidebar();
      renderContentArea();
    }
  } else {
    renderSidebar();
  }

  persistSessionNow();
}

// Disconnects every open session except `id`, one at a time so each keeps
// its own unsaved-changes confirmation and IPC teardown.
async function disconnectOtherSessions(id: string) {
  const others = appState.connSessions.value.filter((s) => s.id !== id);
  for (const s of others) {
    await disconnectSession(s.id);
  }
}

async function disconnectAllSessions() {
  const all = [...appState.connSessions.value];
  for (const s of all) {
    await disconnectSession(s.id);
  }
}

function resetTabsAndLiveState() {
  appState.openTabs.set([]);
  appState.activeTab.set(null);
  appState.tableState.set(freshTableState());
  appState.tableMetadata.set([]);
  appState.selectedRecord.set(null);
  appState.filterRules.set([]);
}

// Flush the currently-active tab's live state into the focused session, then
// write every open connection session to localStorage so they can all be
// restored on the next launch — unless nothing is open, in which case
// there's nothing worth remembering.
function persistSessionNow() {
  persistCurrentTabState();
  const sessions = appState.connSessions.value;
  if (sessions.length === 0) {
    clearSession();
    return;
  }
  saveSession(sessions, appState.activeConn.value?.config.id ?? null);
}

// ── Content area (tab strip + active tab body) ─────────────────────────────────

let sqlEditor: SqlEditor | null = null;
let dataGrid: DataGrid | null = null;
let filterBar: FilterBar | null = null;
let recordPanel: RecordPanel | null = null;

// Monotonic id for the active table tab's in-flight data fetch (A14), and a
// handle to that tab's `loadTableData` so pagination can reload rows in place
// instead of tearing down and rebuilding the whole tab (A28).
let tableDataRequestSeq = 0;
let activeTableReload: (() => void) | null = null;

// Tears down the components owned by the previously-rendered tab body so
// their document/theme subscriptions and CodeMirror views don't leak each
// time a tab is (re)rendered.
function destroyActiveTabComponents() {
  sqlEditor?.destroy();
  dataGrid?.destroy();
  filterBar?.destroy();
  sqlEditor = null;
  dataGrid = null;
  filterBar = null;
  recordPanel = null;
  activeTableReload = null;
}

function confirmDiscardIfDirty(): boolean {
  const rec = appState.selectedRecord.value;
  if (rec?.dirty) {
    return confirm("Discard unsaved changes?");
  }
  return true;
}

function clearRecordSelection() {
  appState.selectedRecord.set(null);
  dataGrid?.setSelectedRow(undefined);
  recordPanel?.clear();
  document.getElementById("record-panel")?.classList.remove("open");
}

function schemaForEngine(): string | undefined {
  const ac = appState.activeConn.value;
  if (!ac) return undefined;
  if (ac.config.engine === "mysql") return ac.selectedDatabase;
  return ac.selectedSchema;
}

function renderContentArea() {
  const ac = appState.activeConn.value;
  if (!ac) {
    tabStripEl.style.display = "none";
    tabStripEl.innerHTML = "";
    showConnectionsScreen();
  } else {
    tabStripEl.style.display = "";
    renderTabStrip();
    renderActiveTabContent();
  }
}

function renderActiveTabContent() {
  destroyActiveTabComponents();
  mainContent.innerHTML = "";
  mainContent.style.overflow = "";
  mainContent.style.padding = "";

  const activeId = appState.activeTab.value;
  const tab = appState.openTabs.value.find((t) => t.id === activeId);

  if (!tab) {
    renderEmptyTabState();
    return;
  }

  mainContent.style.cssText =
    "flex:1;overflow:hidden;display:flex;flex-direction:column;";

  if (tab.kind === "table") {
    renderTableTabContent(tab);
  } else {
    renderQueryTabContent(tab);
  }
}

function renderEmptyTabState() {
  mainContent.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon">▦</div>
      <h2>No tabs open</h2>
      <p>Pick a table from the sidebar, or start a new query.</p>
      <button class="btn btn-primary" id="empty-new-query">New Query</button>
    </div>`;
  document.getElementById("empty-new-query")?.addEventListener("click", () => openQueryTab());
}

function renderQueryTabContent(tab: QueryTab) {
  const ac = appState.activeConn.value;

  const layout = document.createElement("div");
  layout.className = "table-layout";
  mainContent.appendChild(layout);

  const wrap = document.createElement("div");
  wrap.className = "table-main";
  layout.appendChild(wrap);

  const recordPanelEl = document.createElement("aside");
  recordPanelEl.className = "record-panel";
  layout.appendChild(recordPanelEl);

  const queryRecordPanel = new RecordPanel({
    container: recordPanelEl,
    engine: ac?.config.engine ?? "postgres",
    table: tab.title,
    readOnly: true,
    onCommit: async () => {},
    onClose: () => {
      recordPanelEl.classList.remove("open");
      queryRecordPanel.clear();
    },
    onRequestEdit: () => {
      const ac2 = appState.activeConn.value;
      if (!ac2) return;
      const target = inferEditableTarget(sqlEditor?.getLastRunText() ?? tab.sqlDoc, ac2);
      if (!target) {
        alert(
          "This query result can't be edited in place — only a simple single-table SELECT supports editing.",
        );
        return;
      }
      queryRecordPanel.enterEditMode({
        engine: ac2.config.engine,
        schema: target.schema,
        database: target.database,
        table: target.table,
        onCommit: async (sql) => {
          const ac3 = appState.activeConn.value;
          if (!ac3) return;
          const result = await ipc.executeQuery(ac3.connId, sql);
          if (result.error) throw new Error(result.error);
          if (result.affected_rows === 0) {
            throw new Error(
              "No rows were updated — this row may have been changed or deleted by someone else, or the query has no key column to match it.",
            );
          }
          appState.status.set(
            `Updated ${result.affected_rows ?? 1} row(s) · ${result.execution_time_ms}ms`,
          );
          void sqlEditor?.run();
        },
      });
    },
  });

  sqlEditor = new SqlEditor(wrap, {
    initialDoc: tab.sqlDoc,
    initialResult: tab.sqlResult,
    onBeforeNewResult: () => {
      recordPanelEl.classList.remove("open");
      queryRecordPanel.clear();
    },
    onRowClick: (row, rowIndex, columns) => {
      queryRecordPanel.setColumns(columns);
      queryRecordPanel.show({
        rowIndex,
        original: row.map((v) => cloneRowValue(v)),
        draft: row.map((v) => cloneRowValue(v)),
        dirty: false,
      });
      recordPanelEl.classList.add("open");
    },
  });

  if (tab.sqlResult && tab.sqlResult.columns.length > 0) {
    queryRecordPanel.setColumns(tab.sqlResult.columns);
  }

  if (ac) {
    sqlEditor.setConnection(ac.connId, ac.config);
    loadSchemaForEditor(ac.connId, ac.selectedSchema);
  }
}

async function loadSchemaForEditor(connId: string, schema?: string) {
  if (!sqlEditor) return;
  try {
    const tables = await ipc.listTables(connId, schema);
    const tableSchemas: { name: string; columns: ColumnInfo[] }[] = [];
    const toDescribe = tables.slice(0, 50);
    // Fetch a few tables at a time rather than all at once — firing every
    // describe_table call concurrently right after connecting can open a burst of
    // brand-new pool connections (up to the pool's max_connections) at once,
    // which some DB hosts throttle/reject as a connection storm.
    const CONCURRENCY = 5;
    for (let i = 0; i < toDescribe.length; i += CONCURRENCY) {
      const batch = toDescribe.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((t) => ipc.describeTable(connId, schema, t.name)),
      );
      results.forEach((r, j) => {
        if (r.status === "fulfilled") {
          tableSchemas.push({ name: batch[j]!.name, columns: r.value[0] });
        }
      });
    }
    sqlEditor.setSchema(tableSchemas);
  } catch (e) {
    console.warn("Schema autocomplete load failed:", e);
  }
}

function renderTableTabContent(_tab: TableTab) {
  const ac = appState.activeConn.value;
  if (!ac?.selectedTable) {
    renderEmptyTabState();
    return;
  }

  const ts = appState.tableState.value;
  const selected = appState.selectedRecord.value;

  const tableLayout = document.createElement("div");
  tableLayout.className = "table-layout";
  mainContent.appendChild(tableLayout);

  const tableMain = document.createElement("div");
  tableMain.className = "table-main";
  tableLayout.appendChild(tableMain);

  const recordPanelEl = document.createElement("aside");
  recordPanelEl.className = "record-panel";
  recordPanelEl.id = "record-panel";
  if (selected) recordPanelEl.classList.add("open");
  tableLayout.appendChild(recordPanelEl);

  // Toolbar
  const toolbar = document.createElement("div");
  toolbar.className = "grid-toolbar";

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "btn btn-secondary";
  refreshBtn.innerHTML = "⟳ Refresh";
  refreshBtn.title = "Refresh (F5)";
  refreshBtn.onclick = () => {
    if (!confirmDiscardIfDirty()) return;
    clearRecordSelection();
    void loadTableData();
  };

  // Latest index metadata for this table (fed by loadTableMetadata) — used
  // by the Structure modal. describe_table already returns it; it used to be
  // destructured away and dropped.
  let lastIndexes: IndexInfo[] = [];

  const structureBtn = document.createElement("button");
  structureBtn.className = "btn btn-secondary";
  structureBtn.innerHTML = "⚙ Structure";
  structureBtn.title = "Show columns & indexes";
  structureBtn.onclick = () => {
    const cols = appState.tableMetadata.value;
    const label = `${schemaForEngine() ? schemaForEngine() + "." : ""}${ac.selectedTable}`;
    showStructureModal(label, cols, lastIndexes);
  };

  const exportBtn = createExportButton({
    formats: ["csv", "tsv", "xlsx", "json", "markdown", "html", "sql"],
    onSelect: (format) => exportData(format),
  });

  const rowInfo = document.createElement("span");
  rowInfo.id = "row-info";
  rowInfo.style.cssText = "font-size:11px;color:var(--text-muted);flex:1;";

  const newRowBtn = document.createElement("button");
  newRowBtn.className = "btn btn-secondary";
  newRowBtn.innerHTML = "+ New Row";
  newRowBtn.title = "Insert a new row";
  newRowBtn.onclick = () => {
    if (!confirmDiscardIfDirty()) return;
    clearRecordSelection();
    openInsertPanel();
  };

  toolbar.appendChild(refreshBtn);
  toolbar.appendChild(structureBtn);
  toolbar.appendChild(exportBtn.element);
  toolbar.appendChild(newRowBtn);
  toolbar.appendChild(rowInfo);
  tableMain.appendChild(toolbar);

  // Bulk-action bar — shown when one or more rows are Cmd/Ctrl+clicked
  const selectionBar = document.createElement("div");
  selectionBar.className = "selection-bar";
  selectionBar.style.display = "none";
  tableMain.appendChild(selectionBar);

  // Filter bar
  const filterContainer = document.createElement("div");
  filterContainer.className = "filter-bar";
  tableMain.appendChild(filterContainer);

  filterBar = new FilterBar(
    filterContainer,
    async (where) => {
      if (!confirmDiscardIfDirty()) return;
      clearRecordSelection();
      const s = appState.tableState.value;
      appState.tableState.set({ ...s, whereClause: where, page: 0 });
      appState.filterRules.set(filterBar!.getRules().map((r) => ({ ...r })));
      await loadTableData();
    },
    ac.config.engine,
  );

  if (appState.tableMetadata.value.length > 0) {
    filterBar.setColumns(appState.tableMetadata.value);
  }

  // Restore any persisted filter rules for the active tab
  const pendingRules = appState.filterRules.value;
  if (pendingRules.length > 0) {
    filterBar.setRules(pendingRules.map((r) => ({ ...r })));
  }

  // Grid container
  const gridContainer = document.createElement("div");
  gridContainer.style.cssText =
    "flex:1;overflow:hidden;display:flex;flex-direction:column;";
  tableMain.appendChild(gridContainer);

  dataGrid = new DataGrid({
    container: gridContainer,
    sortCol: ts.orderBy,
    sortDesc: ts.orderDesc,
    selectedRowIndex: selected?.rowIndex,
    onHeaderClick: async (col) => {
      if (!confirmDiscardIfDirty()) return;
      clearRecordSelection();
      const s = appState.tableState.value;
      const desc = s.orderBy === col ? !s.orderDesc : false;
      appState.tableState.set({ ...s, orderBy: col, orderDesc: desc, page: 0 });
      dataGrid?.updateSort(col, desc);
      await loadTableData();
    },
    onRowClick: (row, rowIndex) => selectRecord(row, rowIndex),
    onSelectionChange: (indices) => {
      updateSelectionBar(indices);
      // Editing a single record's fields only makes sense when exactly one
      // row is selected — close the panel for 0 or multi-row selections
      // (onRowClick handles (re)opening it for the exactly-one-row case).
      if (indices.length !== 1 && appState.selectedRecord.value) {
        clearRecordSelection();
      }
    },
  });

  // Record panel
  recordPanel = new RecordPanel({
    container: recordPanelEl,
    engine: ac.config.engine,
    schema: schemaForEngine(),
    database: ac.selectedDatabase ?? ac.config.database,
    table: ac.selectedTable,
    onCommit: async (sql) => {
      const ac2 = appState.activeConn.value;
      if (!ac2) return;
      const result = await ipc.executeQuery(ac2.connId, sql);
      if (result.error) throw new Error(result.error);
      if (result.affected_rows === 0) {
        throw new Error(
          "No rows were updated — this row may have been changed or deleted by someone else, or the table has no key to match it. Reload the table to see the current data.",
        );
      }
      appState.status.set(
        `Updated ${result.affected_rows ?? 1} row(s) · ${result.execution_time_ms}ms`,
      );
      const rec = appState.selectedRecord.value;
      if (rec) {
        const newOriginal = rec.draft.map((v) => cloneRowValue(v));
        const updated = { ...rec, original: newOriginal, dirty: false };
        appState.selectedRecord.set(updated);
        recordPanel?.show(updated);
      }
      await loadTableData();
    },
    onDelete: async (sql) => {
      const ac2 = appState.activeConn.value;
      if (!ac2) return;
      const result = await ipc.executeQuery(ac2.connId, sql);
      if (result.error) throw new Error(result.error);
      if (result.affected_rows === 0) {
        throw new Error(
          "No rows were deleted — this row may already be gone, or the table has no key to match it.",
        );
      }
      appState.status.set(`Deleted 1 row · ${result.execution_time_ms}ms`);
      clearRecordSelection();
      await loadTableData();
    },
    onClose: () => clearRecordSelection(),
  });
  recordPanel.setColumns(appState.tableMetadata.value);
  if (selected) recordPanel.show(selected);

  void loadTableMetadata();

  // Pagination
  const pagination = document.createElement("div");
  pagination.className = "pagination";
  pagination.id = "pagination";
  tableMain.appendChild(pagination);

  // Expose this tab's reload so changePage/changePageSize can refresh rows in
  // place rather than rebuilding the entire tab (which re-issues describeTable
  // and leaks the torn-down components).
  activeTableReload = () => void loadTableData();
  loadTableData();

  function selectRecord(row: RowValue[], rowIndex: number) {
    if (!confirmDiscardIfDirty()) return;

    const original = row.map((v) => cloneRowValue(v));
    const record = {
      rowIndex,
      original,
      draft: original.map((v) => cloneRowValue(v)),
      dirty: false,
    };
    appState.selectedRecord.set(record);
    dataGrid?.setSelectedRow(rowIndex);
    recordPanelEl.classList.add("open");
    recordPanel?.show(record);
  }

  function openInsertPanel() {
    const columns = appState.tableMetadata.value;
    if (columns.length === 0) return;

    // Build a draft row: use default_value if present, otherwise null
    const draft: RowValue[] = columns.map((col) => {
      if (col.default_value) {
        // Return null so the DB applies the default — the buildInsertSql
        // function will skip columns with defaults when the value is null.
        return null;
      }
      return null;
    });

    recordPanelEl.classList.add("open");
    recordPanel?.showInsert(draft);
  }

  async function loadTableMetadata() {
    const ac2 = appState.activeConn.value;
    if (!ac2?.selectedTable) return;
    try {
      const [columns, indexes] = await ipc.describeTable(
        ac2.connId,
        schemaForEngine(),
        ac2.selectedTable,
      );
      lastIndexes = indexes;
      appState.tableMetadata.set(columns);
      recordPanel?.setColumns(columns);
    } catch (e) {
      console.warn("Failed to load table metadata:", e);
    }
  }

  // ── Load table data ─────────────────────────────────────────────────────
  async function loadTableData() {
    const s = appState.tableState.value;
    const ac2 = appState.activeConn.value;
    if (!ac2?.selectedTable) return;

    // Guard against a slow response painting stale rows onto a grid that has
    // since moved on (fast table switch, late auto-refresh). Only the most
    // recent call is allowed to touch the grid.
    const reqId = ++tableDataRequestSeq;
    const reqConnId = ac2.connId;
    const reqTable = ac2.selectedTable;
    // Ownership of the loading overlay: whichever call is the most recent one
    // must always clear it, even if it declined to paint. This is deliberately
    // NOT the same test as isCurrent() — tying the overlay to the conn/table
    // match meant a request whose table drifted mid-fetch bailed out without
    // ever turning the spinner off, leaving it stuck on top of good rows.
    const isLatest = () => reqId === tableDataRequestSeq;
    const isCurrent = () => {
      if (!isLatest()) return false;
      const now = appState.activeConn.value;
      return !!now && now.connId === reqConnId && now.selectedTable === reqTable;
    };

    rowInfo.textContent = "Loading…";
    dataGrid?.setLoading(true);
    appState.tableState.set({ ...s, loading: true });

    try {
      const [rows, total] = await Promise.all([
        ipc.fetchTableRows(
          ac2.connId,
          schemaForEngine(),
          ac2.selectedTable,
          {
            limit: s.pageSize,
            offset: s.page * s.pageSize,
            order_by: s.orderBy,
            order_desc: s.orderDesc,
          },
          s.whereClause || undefined,
        ),
        ipc.countRows(
          ac2.connId,
          schemaForEngine(),
          ac2.selectedTable,
          s.whereClause || undefined,
        ),
      ]);

      if (!isCurrent()) return;
      dataGrid?.setLoading(false);

      if (rows.error) {
        rowInfo.textContent = `Error: ${rows.error}`;
        return;
      }

      // A delete/filter can leave `page` past the last page — clamp and
      // refetch so the grid isn't stranded on an empty out-of-range page
      // ("Rows 21–5 of 5").
      const maxPage = Math.max(0, Math.ceil(total / s.pageSize) - 1);
      if (s.page > maxPage) {
        appState.tableState.set({ ...appState.tableState.value, page: maxPage });
        return loadTableData();
      }

      appState.tableState.set({
        ...appState.tableState.value,
        totalRows: total,
        loading: false,
      });
      dataGrid?.setData(rows);
      const sel = appState.selectedRecord.value;
      if (sel) dataGrid?.setSelectedRow(sel.rowIndex);

      const metaCols = appState.tableMetadata.value;
      const filterCols = rows.columns.length > 0 ? rows.columns : metaCols;
      if (filterCols.length > 0) {
        filterBar?.setColumns(filterCols);
      }

      const start = s.page * s.pageSize + 1;
      const end = Math.min(start + rows.row_count - 1, total);
      rowInfo.textContent = `Rows ${start}–${end} of ${total} · ${rows.execution_time_ms}ms`;
      renderPagination(pagination, total, s.page, s.pageSize);
    } catch (e) {
      rowInfo.textContent = `Error: ${e}`;
    } finally {
      // isLatest, not isCurrent — see the comment where they're defined. A
      // superseded request leaves the overlay to its successor; the newest
      // one always clears it, so the spinner can never be left stuck.
      if (isLatest()) {
        dataGrid?.setLoading(false);
        appState.tableState.set({ ...appState.tableState.value, loading: false });
      }
    }
  }

  // ── Export ──────────────────────────────────────────────────────────────
  async function exportData(format: ExportFormat) {
    const s = appState.tableState.value;
    const ac2 = appState.activeConn.value;
    if (!ac2?.selectedTable) return;
    try {
      const result = await ipc.fetchTableRows(
        ac2.connId,
        schemaForEngine(),
        ac2.selectedTable,
        {
          limit: MAX_EXPORT_ROWS,
          offset: 0,
          order_by: s.orderBy,
          order_desc: s.orderDesc,
        },
        s.whereClause || undefined,
      );
      if (result.error) {
        alert(`Export failed: ${result.error}`);
        return;
      }
      await saveExport(
        format,
        result.columns,
        result.rows,
        `${ac2.selectedTable}.${formatMeta[format].ext}`,
        ac2.selectedTable,
        ac2.config.engine,
      );
    } catch (e) {
      alert(`Export failed: ${e}`);
    }
  }

  // ── Multi-select bulk actions ──────────────────────────────────────────
  function updateSelectionBar(indices: number[]) {
    selectionBar.innerHTML = "";
    if (indices.length === 0) {
      selectionBar.style.display = "none";
      return;
    }
    selectionBar.style.display = "flex";

    const label = document.createElement("span");
    label.className = "selection-bar-label";
    label.textContent = `${indices.length} row${indices.length === 1 ? "" : "s"} selected`;
    selectionBar.appendChild(label);

    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-danger";
    delBtn.textContent = "Delete";
    delBtn.onclick = () => void deleteSelectedRows();
    selectionBar.appendChild(delBtn);

    const selExportBtn = createExportButton({
      formats: ["csv", "tsv", "xlsx", "json", "markdown", "html", "sql"],
      onSelect: (format) => void exportSelectedRows(format),
    });
    selectionBar.appendChild(selExportBtn.element);

    const clearBtn = document.createElement("button");
    clearBtn.className = "btn btn-secondary";
    clearBtn.textContent = "Clear";
    clearBtn.onclick = () => dataGrid?.clearSelection();
    selectionBar.appendChild(clearBtn);
  }

  async function deleteSelectedRows() {
    const ac2 = appState.activeConn.value;
    const sel = dataGrid?.getSelectionData();
    if (!ac2?.selectedTable || !sel || sel.rows.length === 0) return;
    if (!confirm(`Delete ${sel.rows.length} row(s)? This cannot be undone.`)) return;

    const result = buildDeleteSql({
      engine: ac2.config.engine,
      schema: schemaForEngine(),
      database: ac2.selectedDatabase,
      table: ac2.selectedTable,
      columns: appState.tableMetadata.value,
      rows: sel.rows,
    });
    if ("error" in result) {
      alert(result.error);
      return;
    }

    try {
      const res = await ipc.executeQuery(ac2.connId, result.sql);
      if (res.error) {
        alert(`Delete failed: ${res.error}`);
        return;
      }
      if (res.affected_rows === 0) {
        alert(
          "No rows were deleted — they may have already been removed, or this table has no key column to match them. Reloading the table.",
        );
      } else {
        appState.status.set(`Deleted ${res.affected_rows ?? sel.rows.length} row(s)`);
      }
      dataGrid?.clearSelection();
      await loadTableData();
    } catch (e) {
      alert(`Delete failed: ${e}`);
    }
  }

  async function exportSelectedRows(format: ExportFormat) {
    const ac2 = appState.activeConn.value;
    const sel = dataGrid?.getSelectionData();
    if (!ac2?.selectedTable || !sel || sel.rows.length === 0) return;
    try {
      await saveExport(
        format,
        sel.columns,
        sel.rows,
        `${ac2.selectedTable}_selected.${formatMeta[format].ext}`,
        ac2.selectedTable,
        ac2.config.engine,
      );
    } catch (e) {
      alert(`Export failed: ${e}`);
    }
  }
}

// "All" is represented by a large sentinel limit rather than a real
// unbounded fetch, so it can flow through the existing LIMIT/OFFSET
// pipeline (PageRequest.limit is u64 on the Rust side) unchanged.
const PAGE_SIZE_ALL = 1_000_000_000;
const PAGE_SIZE_OPTIONS: { value: number; label: string }[] = [
  { value: 10, label: "10" },
  { value: 50, label: "50" },
  { value: 100, label: "100" },
  { value: 500, label: "500" },
  { value: 1000, label: "1000" },
  { value: PAGE_SIZE_ALL, label: "All" },
];

function renderPagination(
  el: HTMLElement,
  total: number,
  page: number,
  pageSize: number,
) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  el.innerHTML = "";

  const prev = document.createElement("button");
  prev.className = "btn btn-secondary";
  prev.innerHTML = "‹ Prev";
  prev.disabled = page === 0;
  prev.onclick = () => changePage(page - 1);

  const info = document.createElement("span");
  info.className = "page-info";
  info.textContent = `Page ${page + 1} of ${totalPages}`;

  const next = document.createElement("button");
  next.className = "btn btn-secondary";
  next.innerHTML = "Next ›";
  next.disabled = page >= totalPages - 1;
  next.onclick = () => changePage(page + 1);

  const pageSizeSelect = document.createElement("select");
  pageSizeSelect.className = "page-size-select";
  pageSizeSelect.title = "Rows per page";
  const knownSizes = new Set(PAGE_SIZE_OPTIONS.map((o) => o.value));
  const options = knownSizes.has(pageSize)
    ? PAGE_SIZE_OPTIONS
    : [...PAGE_SIZE_OPTIONS, { value: pageSize, label: String(pageSize) }].sort(
        (a, b) => a.value - b.value,
      );
  for (const opt of options) {
    const optionEl = document.createElement("option");
    optionEl.value = String(opt.value);
    optionEl.textContent = opt.label;
    optionEl.selected = opt.value === pageSize;
    pageSizeSelect.appendChild(optionEl);
  }
  pageSizeSelect.onchange = () => changePageSize(Number(pageSizeSelect.value));

  const pageSizeLabel = document.createElement("span");
  pageSizeLabel.textContent = "/ page";

  el.appendChild(prev);
  el.appendChild(info);
  el.appendChild(next);
  el.appendChild(pageSizeSelect);
  el.appendChild(pageSizeLabel);
}

function changePage(newPage: number) {
  if (!confirmDiscardIfDirty()) return;
  clearRecordSelection();
  const s = appState.tableState.value;
  appState.tableState.set({ ...s, page: newPage });
  // Reload rows in place when we can; only fall back to a full tab rebuild if
  // this isn't a live table tab.
  if (activeTableReload) activeTableReload();
  else renderActiveTabContent();
}

const ALL_PAGE_CONFIRM_THRESHOLD = 50_000;

function changePageSize(newPageSize: number) {
  if (!confirmDiscardIfDirty()) return;
  const s = appState.tableState.value;
  // "All" pulls the whole table into memory in one grid. Warn before doing
  // that on a large (or unknown-size) table.
  if (
    newPageSize >= PAGE_SIZE_ALL &&
    (s.totalRows === 0 || s.totalRows > ALL_PAGE_CONFIRM_THRESHOLD)
  ) {
    const rowsText =
      s.totalRows > 0 ? `${s.totalRows.toLocaleString()} rows` : "every row";
    if (
      !confirm(
        `Load ${rowsText} into the grid at once? This can be slow and use a lot of memory.`,
      )
    ) {
      renderActiveTabContent(); // reset the page-size <select>
      return;
    }
  }
  clearRecordSelection();
  appState.tableState.set({ ...s, pageSize: newPageSize, page: 0 });
  if (activeTableReload) activeTableReload();
  else renderActiveTabContent();
}

function showConnectionsScreen() {
  destroyActiveTabComponents();
  mainContent.innerHTML = "";
  mainContent.style.overflow = "auto";
  mainContent.style.padding = "20px";

  const conns = appState.connections.value;

  const heading = document.createElement("div");
  heading.className = "section-heading";
  heading.innerHTML = `<h2>Saved Connections</h2>`;

  const addBtn = document.createElement("button");
  addBtn.className = "btn btn-primary";
  addBtn.textContent = "+ New Connection";
  addBtn.onclick = () =>
    showConnectionModal(undefined, () => {
      showConnectionsScreen();
      renderSidebar();
    });
  heading.appendChild(addBtn);
  mainContent.appendChild(heading);

  if (pendingRestores.size > 0) {
    const names = appState.connections.value
      .filter((c) => pendingRestores.has(c.id))
      .map((c) => c.name);
    const banner = document.createElement("div");
    banner.className = "error-banner";
    banner.style.margin = "0 0 14px";
    banner.textContent = `Couldn't automatically reconnect to ${names.join(", ") || "some connections"} on launch. Click Connect to retry — their tabs are still remembered.`;
    mainContent.appendChild(banner);
  }

  if (conns.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.style.marginTop = "40px";
    empty.innerHTML = `<p style="color:var(--text-faint)">No connections configured yet.</p>`;
    mainContent.appendChild(empty);
    return;
  }

  conns.forEach((cfg) => {
    const card = document.createElement("div");
    card.className = "conn-card";

    const detail = [cfg.engine.toUpperCase()];
    if (cfg.host) detail.push(`${cfg.host}:${cfg.port ?? ""}`);
    if (cfg.file_path) detail.push(cfg.file_path);
    if (cfg.database) detail.push(`/${cfg.database}`);
    if (cfg.username) detail.push(`@${cfg.username}`);

    card.innerHTML = `
      <div class="conn-card-info">
        <div class="conn-card-name">${esc(cfg.name)}</div>
        <div class="conn-card-detail">${esc(detail.join(" "))}</div>
      </div>
      <div class="conn-card-actions"></div>
    `;

    const actions = card.querySelector(".conn-card-actions")!;

    const connectBtn = document.createElement("button");
    connectBtn.className = "btn btn-primary";
    connectBtn.textContent = "Connect";
    connectBtn.onclick = () => connectToDb(cfg);

    const editBtn = document.createElement("button");
    editBtn.className = "btn btn-secondary";
    editBtn.textContent = "Edit";
    editBtn.onclick = () =>
      showConnectionModal(cfg, () => showConnectionsScreen());

    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-danger";
    delBtn.textContent = "Delete";
    delBtn.onclick = async () => {
      if (!confirm(`Delete connection "${cfg.name}"?`)) return;
      try {
        await ipc.deleteConnection(cfg.id);
        const all = await ipc.loadConnections();
        appState.connections.set(all);
        showConnectionsScreen();
        renderSidebar();
      } catch (e) {
        alert(`Error: ${e}`);
      }
    };

    actions.append(connectBtn, editBtn, delBtn);
    mainContent.appendChild(card);
  });
}

// ── Connect to DB ─────────────────────────────────────────────────────────────

// Raw IPC connect + metadata load — no signal/UI writes. Returns a fresh,
// unfocused ConnSession with an empty tab strip.
async function establishConnSession(
  cfg: ConnectionConfig,
  overrideDatabase?: string,
): Promise<ConnSession> {
  // If a specific database is wanted (saved config, or a restored session),
  // actually connect to it — don't connect to the engine default and just
  // *display* a different name. That mismatch made the DB dropdown a no-op
  // (switchDatabase's "already selected" guard) and left the tree empty
  // because every query hit the wrong database.
  const effectiveCfg: ConnectionConfig =
    overrideDatabase && overrideDatabase !== cfg.database
      ? { ...cfg, database: overrideDatabase }
      : cfg;

  const connId = await ipc.connectDb(effectiveCfg);

  const [databases, schemas] = await Promise.all([
    ipc.listDatabases(connId).catch(() => [] as string[]),
    ipc.listSchemas(connId).catch(() => []),
  ]);

  const defaultSchema =
    schemas.find((s) => s.name === "public" || s.name === "dbo")?.name ??
    schemas[0]?.name;

  // Resolve the default schema *before* listing tables, so the very first
  // table list matches it — same as every later switchSchema() call does.
  const tables = await ipc.listTables(connId, defaultSchema);

  // The database the connection actually landed on. With no explicit db the
  // engine picks its own default ("postgres", "mysql", the login default) —
  // ask it rather than guessing `databases[0]`.
  let selectedDb = effectiveCfg.database || undefined;
  if (
    !selectedDb &&
    (effectiveCfg.engine === "postgres" || effectiveCfg.engine === "mysql")
  ) {
    const dbQuery =
      effectiveCfg.engine === "postgres"
        ? "SELECT current_database()"
        : "SELECT DATABASE()";
    try {
      const r = await ipc.executeQuery(connId, dbQuery);
      const v = r.rows?.[0]?.[0];
      if (typeof v === "string" && v) selectedDb = v;
    } catch {
      /* fall through to the databases[0] guess below */
    }
  }
  if (!selectedDb && databases.length > 0) selectedDb = databases[0];

  return {
    id: crypto.randomUUID(),
    connId,
    config: effectiveCfg,
    databases,
    selectedDatabase: selectedDb,
    schemas,
    selectedSchema: defaultSchema,
    tables,
    openTabs: [],
    activeTabId: null,
  };
}

function remapRestoredTabs(tabs: AppTab[], connId: string): AppTab[] {
  return tabs.map((t) => ({ ...t, connId }));
}

// "Connected: <name>" for engines with no database concept (SQLite), or
// "Connected: <name> / <database>" for the rest — matches TablePlus, which
// always names the active database alongside the connection, not just the
// connection itself.
function connectedStatusText(session: ConnSession): string {
  return session.selectedDatabase
    ? `Connected: ${session.config.name} / ${session.selectedDatabase}`
    : `Connected: ${session.config.name}`;
}

// Points activeConnId/activeConn/openTabs/activeTab at a session (already
// present in connSessions) and refreshes the sidebar/rail to match.
function focusSession(session: ConnSession) {
  appState.activeConnId.set(session.id);
  appState.activeConn.set(session);
  appState.openTabs.set([...session.openTabs]);
  appState.activeTab.set(session.activeTabId);
  renderSidebar();
  startAutoRefresh();
  void refreshSchemaTree({ silent: true });
}

// Renders the just-focused session's tab strip + content: hydrates the
// table-tab scratch signals if its active tab is a table, or opens a
// default query tab if it has no tabs at all.
function activateFocusedSession(session: ConnSession) {
  if (session.openTabs.length > 0) {
    const activeTabObj = session.openTabs.find((t) => t.id === session.activeTabId);
    if (activeTabObj?.kind === "table") {
      loadTableTabIntoSignals(activeTabObj);
      // renderTableTabContent reads the table to show from
      // activeConn.selectedTable, not from the tab — point it at the tab
      // being activated. Without this a restored table tab came back blank
      // (selectedTable is undefined on a freshly established session) until
      // the user clicked it in the tab strip.
      const ac = appState.activeConn.value;
      if (ac) {
        appState.activeConn.set({
          ...ac,
          selectedTable: activeTabObj.name,
          selectedSchema: activeTabObj.schema ?? ac.selectedSchema,
          selectedDatabase: activeTabObj.database ?? ac.selectedDatabase,
        });
      }
    }
    tabStripEl.style.display = "";
    renderTabStrip();
    renderActiveTabContent();
  } else {
    openQueryTab();
  }
}

// Switches focus to an already-open connection session. Used by the rail's
// avatar buttons.
function switchToConnSession(id: string) {
  if (id === appState.activeConnId.value) return;
  const target = appState.connSessions.value.find((s) => s.id === id);
  if (!target) return;

  // Save the outgoing focused session's live tab state first
  persistCurrentTabState();

  focusSession(target);
  statusDot.className = "status-dot connected";
  appState.status.set(connectedStatusText(target));
  activateFocusedSession(target);
  persistSessionNow();
}

// Connections that boot() couldn't auto-reconnect (keyed by saved-config
// id), so a manual "Connect" click on them still restores their tabs
// instead of starting blank. Entries are removed once a reconnect succeeds.
const pendingRestores = new Map<string, StoredConnSession>();

// Saved-config ids with a connect currently in flight. Two fast clicks on a
// "Connect" button both passed the `existing` check (which only sees
// *completed* sessions) and each opened its own duplicate live session.
const connectInFlight = new Set<string>();

// The interactive "user picked a saved connection" path — opens a new
// session alongside whatever else is already connected, or just focuses it
// if it's already open. `restoreParam` (used by boot()) seeds it with a
// previously-persisted tab strip instead of a blank query tab; a manual
// click falls back to a pending auto-reconnect that failed earlier, if any.
async function connectToDb(cfg: ConnectionConfig, restoreParam?: StoredConnSession) {
  const existing = appState.connSessions.value.find((s) => s.config.id === cfg.id);
  if (existing && !restoreParam) {
    switchToConnSession(existing.id);
    return;
  }
  if (connectInFlight.has(cfg.id)) return;
  connectInFlight.add(cfg.id);

  const restore = restoreParam ?? pendingRestores.get(cfg.id);

  appState.status.set(`Connecting: ${cfg.name}…`);
  statusDot.className = "status-dot";

  try {
    const session = await establishConnSession(cfg, restore?.selectedDatabase);

    if (restore) {
      session.selectedSchema = restore.selectedSchema ?? session.selectedSchema;
      session.openTabs = remapRestoredTabs(restore.tabs, session.connId);
      session.activeTabId =
        restore.activeTabId && session.openTabs.some((t) => t.id === restore.activeTabId)
          ? restore.activeTabId
          : (session.openTabs[0]?.id ?? null);
    }

    appState.connSessions.set([...appState.connSessions.value, session]);
    focusSession(session);

    statusDot.className = "status-dot connected";
    appState.status.set(connectedStatusText(session));
    pendingRestores.delete(cfg.id);

    activateFocusedSession(session);
  } catch (e) {
    statusDot.className = "status-dot error";
    appState.status.set(`Error: ${e}`);
    alert(`Connection failed:\n${e}`);
  } finally {
    connectInFlight.delete(cfg.id);
  }
}

// ── Connection state subscription ─────────────────────────────────────────────

appState.connections.subscribe(() => {
  if (!appState.activeConn.value) renderSidebar();
});

// Flush the active tab's live state to storage on the way out — covers
// edits (typed SQL, filters) that haven't triggered a tab switch yet.
window.addEventListener("beforeunload", () => {
  persistSessionNow();
});

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  try {
    const conns = await ipc.loadConnections();
    appState.connections.set(conns);
  } catch (e) {
    console.error("Boot error:", e);
  }
  renderSidebar();

  const stored = loadSession();
  const restorable = (stored?.sessions ?? [])
    .map((s) => ({
      stored: s,
      cfg: appState.connections.value.find((c) => c.id === s.connConfigId),
    }))
    .filter(
      (x): x is { stored: StoredConnSession; cfg: ConnectionConfig } => !!x.cfg,
    );

  if (restorable.length === 0) {
    renderContentArea();
    return;
  }

  appState.status.set(
    restorable.length === 1
      ? `Reconnecting to ${restorable[0]!.cfg.name}…`
      : `Reconnecting to ${restorable.length} connections…`,
  );

  const results = await Promise.allSettled(
    restorable.map(async ({ stored: s, cfg }) => {
      const session = await establishConnSession(cfg, s.selectedDatabase);
      session.selectedSchema = s.selectedSchema ?? session.selectedSchema;
      session.openTabs = remapRestoredTabs(s.tabs, session.connId);
      session.activeTabId =
        s.activeTabId && session.openTabs.some((t) => t.id === s.activeTabId)
          ? s.activeTabId
          : (session.openTabs[0]?.id ?? null);
      return session;
    }),
  );

  const restoredSessions: ConnSession[] = [];
  const failed: { name: string; reason: unknown }[] = [];
  results.forEach((r, i) => {
    const { stored: s, cfg } = restorable[i]!;
    if (r.status === "fulfilled") {
      restoredSessions.push(r.value);
    } else {
      console.warn(`Failed to reconnect "${cfg.name}":`, r.reason);
      // Keep it around so a manual Connect click still restores its tabs.
      pendingRestores.set(cfg.id, s);
      failed.push({ name: cfg.name, reason: r.reason });
    }
  });

  // Don't clear the stored session on a failed reconnect (server down,
  // offline, etc.) — the whole point is to remember it and keep trying,
  // not to silently forget the user's open connections and tabs.
  if (restoredSessions.length === 0) {
    appState.status.set(
      failed.length === 1
        ? `Couldn't reconnect to ${failed[0]!.name}: ${failed[0]!.reason}`
        : `Couldn't reconnect to ${failed.length} connections — click one to retry`,
    );
    renderContentArea();
    return;
  }

  appState.connSessions.set(restoredSessions);

  const focusTarget =
    restoredSessions.find((s) => s.config.id === stored?.activeConnConfigId) ??
    restoredSessions[0]!;

  focusSession(focusTarget);
  statusDot.className = "status-dot connected";
  appState.status.set(
    failed.length > 0
      ? `${connectedStatusText(focusTarget)} (${failed.length} failed to reconnect)`
      : connectedStatusText(focusTarget),
  );
  activateFocusedSession(focusTarget);
}

boot();

// ── Tab Management ─────────────────────────────────────────────────────────────

function generateTabId(): string {
  return `tab_${crypto.randomUUID()}`;
}

function freshTableState(): TableState {
  return {
    totalRows: 0,
    page: 0,
    pageSize: 100,
    orderDesc: false,
    whereClause: "",
    loading: false,
    columns: [],
  };
}

// Persist the live signals / component state back into the currently-active
// tab so switching away preserves its filters / sort / page / SQL doc, etc.
function persistCurrentTabState() {
  const activeId = appState.activeTab.value;
  if (!activeId) return;
  const tabs = appState.openTabs.value;
  const idx = tabs.findIndex((t) => t.id === activeId);
  if (idx === -1) return;
  const tab = tabs[idx]!;

  let updated: AppTab;
  if (tab.kind === "table") {
    updated = {
      ...tab,
      tableState: { ...appState.tableState.value },
      tableMetadata: [...appState.tableMetadata.value],
      selectedRecord: appState.selectedRecord.value
        ? {
            ...appState.selectedRecord.value,
            original: appState.selectedRecord.value.original.map((v) => cloneRowValue(v)),
            draft: appState.selectedRecord.value.draft.map((v) => cloneRowValue(v)),
          }
        : null,
      filterRules: filterBar?.getRules().map((r) => ({ ...r })) ?? [...appState.filterRules.value],
    };
  } else {
    updated = {
      ...tab,
      sqlDoc: sqlEditor?.getDoc() ?? tab.sqlDoc,
      sqlResult: sqlEditor?.getLastResult() ?? tab.sqlResult,
    };
  }

  const next = [...tabs];
  next[idx] = updated;
  appState.openTabs.set(next);
}

// Restore a table tab's stored state into the live signals so
// renderTableTabContent can operate on them unchanged.
function loadTableTabIntoSignals(tab: TableTab) {
  appState.tableState.set({ ...tab.tableState });
  appState.tableMetadata.set([...tab.tableMetadata]);
  appState.selectedRecord.set(
    tab.selectedRecord
      ? {
          ...tab.selectedRecord,
          original: tab.selectedRecord.original.map((v) => cloneRowValue(v)),
          draft: tab.selectedRecord.draft.map((v) => cloneRowValue(v)),
        }
      : null,
  );
  appState.filterRules.set(tab.filterRules.map((r) => ({ ...r })));
}

function renderTabStrip() {
  updateTreeActiveState();

  const tabs = appState.openTabs.value;
  const activeTabId = appState.activeTab.value;

  tabStripEl.innerHTML = "";

  const appendTrailingControls = () => {
    const newTabBtn = document.createElement("button");
    newTabBtn.className = "table-tab-add";
    newTabBtn.innerHTML = "+";
    newTabBtn.title = "New query (⌘T)";
    newTabBtn.onclick = () => openQueryTab();
    tabStripEl.appendChild(newTabBtn);
  };

  if (tabs.length === 0) {
    appendTrailingControls();
    return;
  }

  tabs.forEach((tab) => {
    const isActive = activeTabId === tab.id;
    const item = document.createElement("div");
    item.className = `table-tab${isActive ? " active" : ""}`;
    const label = tab.kind === "table" ? tab.name : tab.title;
    item.title =
      tab.kind === "table"
        ? `${tab.schema ? tab.schema + "." : ""}${tab.name}`
        : tab.title;
    item.onclick = () => switchToTab(tab.id);
    item.oncontextmenu = (e) => {
      e.preventDefault();
      const tabIndex = tabs.indexOf(tab);
      showContextMenu(e.clientX, e.clientY, [
        { label: "Close", onSelect: () => closeTab(tab.id) },
        {
          label: "Close Others",
          onSelect: () => closeOtherTabs(tab.id),
          disabled: tabs.length <= 1,
        },
        {
          label: "Close Tabs to the Right",
          onSelect: () => closeTabsToRight(tab.id),
          disabled: tabIndex >= tabs.length - 1,
        },
        {
          label: "Close Tabs to the Left",
          onSelect: () => closeTabsToLeft(tab.id),
          disabled: tabIndex <= 0,
        },
        {
          label: "Close All Tabs",
          onSelect: () => closeAllTabs(),
          separatorBefore: true,
          danger: true,
        },
      ]);
    };

    const icon = document.createElement("span");
    icon.className = "table-tab-icon";
    icon.textContent = tab.kind === "table" ? "▦" : "❯";

    const labelEl = document.createElement("span");
    labelEl.className = "table-tab-label";
    labelEl.textContent = label;

    const closeBtn = document.createElement("button");
    closeBtn.className = "table-tab-close";
    closeBtn.innerHTML = "&#10005;";
    closeBtn.title = "Close tab";
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    };

    item.appendChild(icon);
    item.appendChild(labelEl);
    item.appendChild(closeBtn);
    tabStripEl.appendChild(item);
  });

  appendTrailingControls();
}

// Reuse an existing tab for the same table/schema/database/conn, else create.
function openOrCreateTableTab(tableName: string, schema?: string, database?: string) {
  const ac = appState.activeConn.value;
  if (!ac) return;

  const tableTabs = appState.openTabs.value.filter(
    (t): t is TableTab => t.kind === "table" && t.connId === ac.connId && t.name === tableName,
  );

  const existing =
    tableTabs.find(
      (t) =>
        (t.schema ?? undefined) === (schema ?? undefined) &&
        (t.database ?? undefined) === (database ?? undefined),
    ) ??
    // Fall back to any tab for this table on this connection. Opening a table
    // from the sidebar should focus the tab that's already showing it; a
    // schema/database field that drifted (e.g. a restored tab recorded before
    // the schema was resolved) shouldn't spawn a duplicate. Deliberate
    // duplicates still go through openTableInNewTab directly.
    tableTabs[0];

  if (existing) {
    switchToTab(existing.id);
    return;
  }

  openTableInNewTab(ac, tableName, schema, database);
}

function switchToTab(tabId: string) {
  const tabs = appState.openTabs.value;
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;

  // Save the outgoing tab's live state first
  persistCurrentTabState();

  appState.activeTab.set(tabId);

  const ac = appState.activeConn.value;
  if (tab.kind === "table" && ac) {
    appState.activeConn.set({
      ...ac,
      selectedTable: tab.name,
      selectedSchema: tab.schema ?? ac.selectedSchema,
      selectedDatabase: tab.database ?? ac.selectedDatabase,
    });
    loadTableTabIntoSignals(tab);
  }

  renderTabStrip();
  renderActiveTabContent();
  persistSessionNow();
}

function closeTab(tabId: string) {
  const tabs = appState.openTabs.value;
  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;
  const tab = tabs[idx]!;
  const wasActive = appState.activeTab.value === tabId;

  // If closing the active table tab that has unsaved edits, ask first
  if (
    wasActive &&
    tab.kind === "table" &&
    appState.selectedRecord.value?.dirty &&
    !confirm("Discard unsaved changes in this tab?")
  ) {
    return;
  }

  const newTabs = tabs.filter((t) => t.id !== tabId);
  appState.openTabs.set(newTabs);

  if (wasActive) {
    if (newTabs.length > 0) {
      // Pick a neighbor to activate
      const nextIdx = Math.min(idx, newTabs.length - 1);
      const nextTab = newTabs[nextIdx]!;
      appState.activeTab.set(nextTab.id);
      const ac = appState.activeConn.value;
      if (nextTab.kind === "table" && ac) {
        appState.activeConn.set({
          ...ac,
          selectedTable: nextTab.name,
          selectedSchema: nextTab.schema ?? ac.selectedSchema,
          selectedDatabase: nextTab.database ?? ac.selectedDatabase,
        });
        loadTableTabIntoSignals(nextTab);
      }
      renderActiveTabContent();
    } else {
      appState.activeTab.set(null);
      // No tabs left — reset table signals to a clean state
      appState.tableState.set(freshTableState());
      appState.tableMetadata.set([]);
      appState.selectedRecord.set(null);
      appState.filterRules.set([]);
      const ac = appState.activeConn.value;
      if (ac) appState.activeConn.set({ ...ac, selectedTable: undefined });
      renderActiveTabContent();
    }
  }

  renderTabStrip();
  persistSessionNow();
}

function closeAllTabs() {
  const tabs = appState.openTabs.value;
  if (tabs.length === 0) return;
  if (!confirm(`Close all ${tabs.length} open tabs?`)) return;

  resetTabsAndLiveState();
  const ac = appState.activeConn.value;
  if (ac) appState.activeConn.set({ ...ac, selectedTable: undefined });
  renderActiveTabContent();
  renderTabStrip();
  persistSessionNow();
}

// True if the given tab has an in-progress, unsaved record edit. For the
// active tab that state lives in the live `selectedRecord` signal; for
// background tabs it's frozen in the tab's own snapshot.
function tabHasUnsavedChanges(tab: AppTab): boolean {
  if (tab.kind !== "table") return false;
  const rec =
    tab.id === appState.activeTab.value ? appState.selectedRecord.value : tab.selectedRecord;
  return !!rec?.dirty;
}

// Shared implementation for the multi-tab "Close Others / Left / Right"
// context-menu actions. Unlike closeAllTabs, this only confirms when a tab
// being closed actually has unsaved edits — closing several clean tabs at
// once shouldn't need a "are you sure?" nag.
function closeTabsBulk(idsToClose: Set<string>) {
  if (idsToClose.size === 0) return;
  const tabs = appState.openTabs.value;

  const dirtyCount = tabs.filter((t) => idsToClose.has(t.id) && tabHasUnsavedChanges(t)).length;
  if (dirtyCount > 0) {
    const msg =
      dirtyCount === 1
        ? "Discard unsaved changes in 1 tab and close it?"
        : `Discard unsaved changes in ${dirtyCount} tabs and close them?`;
    if (!confirm(msg)) return;
  }

  const remaining = tabs.filter((t) => !idsToClose.has(t.id));
  const activeId = appState.activeTab.value;
  const activeWasClosed = activeId !== null && idsToClose.has(activeId);

  appState.openTabs.set(remaining);

  if (activeWasClosed) {
    if (remaining.length > 0) {
      const nextTab = remaining[0]!;
      appState.activeTab.set(nextTab.id);
      const ac = appState.activeConn.value;
      if (nextTab.kind === "table" && ac) {
        appState.activeConn.set({
          ...ac,
          selectedTable: nextTab.name,
          selectedSchema: nextTab.schema ?? ac.selectedSchema,
          selectedDatabase: nextTab.database ?? ac.selectedDatabase,
        });
        loadTableTabIntoSignals(nextTab);
      }
    } else {
      appState.activeTab.set(null);
      appState.tableState.set(freshTableState());
      appState.tableMetadata.set([]);
      appState.selectedRecord.set(null);
      appState.filterRules.set([]);
      const ac = appState.activeConn.value;
      if (ac) appState.activeConn.set({ ...ac, selectedTable: undefined });
    }
    renderActiveTabContent();
  }

  renderTabStrip();
  persistSessionNow();
}

function closeOtherTabs(tabId: string) {
  const ids = new Set(appState.openTabs.value.filter((t) => t.id !== tabId).map((t) => t.id));
  closeTabsBulk(ids);
}

function closeTabsToRight(tabId: string) {
  const tabs = appState.openTabs.value;
  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;
  const ids = new Set(tabs.slice(idx + 1).map((t) => t.id));
  closeTabsBulk(ids);
}

function closeTabsToLeft(tabId: string) {
  const tabs = appState.openTabs.value;
  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;
  const ids = new Set(tabs.slice(0, idx).map((t) => t.id));
  closeTabsBulk(ids);
}

// Always create a brand new table tab (allows duplicates — e.g. two views of
// one table with different filters). Used from the sidebar when no matching
// tab already exists.
function openTableInNewTab(
  ac: ConnSession,
  tableName: string,
  schema?: string,
  database?: string,
) {
  // Save the outgoing tab's state before replacing the live signals
  persistCurrentTabState();

  const tab: TableTab = {
    id: generateTabId(),
    kind: "table",
    name: tableName,
    schema: schema ?? ac.selectedSchema,
    database: database ?? ac.selectedDatabase,
    connId: ac.connId,
    tableState: freshTableState(),
    tableMetadata: [],
    selectedRecord: null,
    filterRules: [],
  };

  appState.openTabs.set([...appState.openTabs.value, tab]);
  appState.activeTab.set(tab.id);

  appState.activeConn.set({
    ...ac,
    selectedTable: tableName,
    selectedSchema: tab.schema,
    selectedDatabase: tab.database,
  });

  // Initialize the live signals for the new tab
  appState.tableState.set({ ...tab.tableState });
  appState.tableMetadata.set([]);
  appState.selectedRecord.set(null);
  appState.filterRules.set([]);

  renderTabStrip();
  renderActiveTabContent();
  persistSessionNow();
}

// Creates a new blank SQL query tab. Used by the tab-strip "+" button, the
// titlebar "New Query" button, and automatically on connect.
function openQueryTab() {
  const ac = appState.activeConn.value;
  if (!ac) return;

  persistCurrentTabState();

  const queryCount = appState.openTabs.value.filter((t) => t.kind === "query").length;
  const tab: QueryTab = {
    id: generateTabId(),
    kind: "query",
    title: `Query ${queryCount + 1}`,
    connId: ac.connId,
    sqlDoc: "SELECT 1;\n",
    sqlResult: null,
  };

  appState.openTabs.set([...appState.openTabs.value, tab]);
  appState.activeTab.set(tab.id);

  tabStripEl.style.display = "";
  renderTabStrip();
  renderActiveTabContent();
  persistSessionNow();
}


// Best-effort detection of "this query is really just browsing one table",
// so the read-only query-result panel can offer in-place editing. Bails out
// (returns null) on anything that isn't a plain single-table SELECT — joins,
// comma'd FROM lists, subqueries, etc. — since there's no reliable single
// target table to build an UPDATE against.
function inferEditableTarget(
  sqlText: string,
  ac: ConnSession,
): { schema?: string; database?: string; table: string } | null {
  const trimmed = sqlText.trim().replace(/;+\s*$/, "");
  if (!/^select\b/i.test(trimmed)) return null;
  if (/\bjoin\b/i.test(trimmed)) return null;

  const m = trimmed.match(/\bfrom\s+([`"[\]\w.]+)/i);
  if (!m) return null;

  let raw = m[1]!;
  if (raw.includes(",")) return null;
  raw = raw.replace(/[`"[\]]/g, "");

  const parts = raw.split(".");
  if (parts.length === 2) {
    return { schema: parts[0], database: ac.selectedDatabase, table: parts[1]! };
  }
  return { schema: ac.selectedSchema, database: ac.selectedDatabase, table: parts[0]! };
}
