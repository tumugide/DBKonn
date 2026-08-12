import "./styles/global.css";
import { ipc, type ConnectionConfig, type ColumnInfo } from "./lib/ipc";
import {
  appState,
  type ThemeType,
  type ActiveConnection,
  type AppTab,
  type TableTab,
  type QueryTab,
  type TableState,
  THEMES,
} from "./lib/store";
import { DataGrid } from "./components/DataGrid";
import { FilterBar } from "./components/FilterBar";
import { SqlEditor } from "./components/SqlEditor";
import { RecordPanel } from "./components/RecordPanel";
import { showConnectionModal } from "./components/ConnectionModal";
import { cloneRowValue } from "./lib/rowEdit";
import type { RowValue } from "./lib/ipc";

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
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

// ── App Shell ─────────────────────────────────────────────────────────────────

const app = document.getElementById("app")!;

app.innerHTML = `
  <div class="titlebar">
    <div class="titlebar-spacer"></div>
    <button class="btn-icon" id="btn-new-query" title="New query (⌘T)">+ Query</button>
    <button class="btn-icon" id="btn-appearance" title="Appearance settings">Theme</button>
  </div>
  <div class="app-layout">
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
const sidebarEl = document.getElementById("sidebar")!;
const mainContent = document.getElementById("tab-content-area")!;
const statusText = document.getElementById("status-text")!;
const statusDot = document.getElementById("status-dot")!;
const themeLabel = document.getElementById("theme-label")!;
const tabStripEl = document.getElementById("table-tabs-list")!;
const newQueryBtn = document.getElementById("btn-new-query") as HTMLButtonElement;

appState.status.subscribe((s) => {
  statusText.textContent = s;
});

// ── Theme: apply on boot, listen for changes ──────────────────────────────────
const savedTheme = loadSavedTheme();
appState.theme.set(savedTheme);
applyTheme(savedTheme);
appState.theme.subscribe(applyTheme);

document.getElementById("btn-appearance")!.addEventListener("click", showAppearanceModal);
themeLabel.addEventListener("click", showAppearanceModal);

newQueryBtn.addEventListener("click", () => openQueryTab());
appState.activeConn.subscribe((ac) => {
  newQueryBtn.disabled = !ac;
});
newQueryBtn.disabled = !appState.activeConn.value;

// ── Sidebar ───────────────────────────────────────────────────────────────────

function renderSidebar() {
  const ac = appState.activeConn.value;
  const buf: string[] = [];

  if (ac) {
    // ── Connected mode ─────────────────────────────────────────────────────
    buf.push(`
      <div class="sidebar-header connected">
        <span>${esc(ac.config.name)}</span>
        <button class="btn-icon danger" id="sb-disconnect" title="Disconnect">Quit</button>
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
    buf.push(`<div class="tree-header">Tables <span class="tree-count">${ac.tables.length}</span></div>`);
    buf.push(`<div style="flex:1;overflow-y:auto;">`);
    ac.tables.forEach((t) => {
      const active = t.name === ac.selectedTable ? " active" : "";
      buf.push(
        `<div class="tree-item${active}" data-table="${esc(t.name)}">${esc(t.name)}</div>`,
      );
    });
    buf.push(`</div>`);
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
      ?.addEventListener("click", disconnectFromDb);

    document.getElementById("sb-db-select")?.addEventListener("change", (e) => {
      const db = (e.target as HTMLSelectElement).value;
      switchDatabase(db);
    });

    document
      .getElementById("sb-schema-select")
      ?.addEventListener("change", (e) => {
        const schema = (e.target as HTMLSelectElement).value;
        switchSchema(schema);
      });

    sidebarEl.querySelectorAll(".tree-item").forEach((el) => {
      el.addEventListener("click", () => {
        const tableName = (el as HTMLElement).dataset["table"]!;
        openOrCreateTableTab(tableName, ac.selectedSchema);
      });
    });
  } else {
    document.getElementById("sb-new-conn")?.addEventListener("click", () => {
      showConnectionModal(undefined, () => renderSidebar());
    });
    renderConnList();
  }
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
      <span class="conn-engine">${cfg.engine.slice(0, 2).toUpperCase()}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(cfg.name)}</span>`;
    item.addEventListener("click", () => connectToDb(cfg));
    listEl.appendChild(item);
  });
}

// ── Database / Schema switching ───────────────────────────────────────────────

async function switchDatabase(dbName: string) {
  const ac = appState.activeConn.value;
  if (!ac || ac.selectedDatabase === dbName) return;

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

async function disconnectFromDb() {
  const ac = appState.activeConn.value;
  if (!ac) return;
  try {
    await ipc.disconnectDb(ac.connId);
  } catch {
    /* ignore */
  }
  appState.activeConn.set(null);
  resetTabsAndLiveState();
  statusDot.className = "status-dot";
  appState.status.set("Disconnected");
  renderSidebar();
  renderContentArea();
}

function resetTabsAndLiveState() {
  appState.openTabs.set([]);
  appState.activeTab.set(null);
  appState.tableState.set(freshTableState());
  appState.tableMetadata.set([]);
  appState.selectedRecord.set(null);
  appState.filterRules.set([]);
}

// ── Content area (tab strip + active tab body) ─────────────────────────────────

let sqlEditor: SqlEditor | null = null;
let dataGrid: DataGrid | null = null;
let filterBar: FilterBar | null = null;
let recordPanel: RecordPanel | null = null;

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
    const results = await Promise.allSettled(
      toDescribe.map((t) => ipc.describeTable(connId, schema, t.name)),
    );
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        tableSchemas.push({ name: toDescribe[i]!.name, columns: r.value[0] });
      }
    });
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

  const exportBtn = document.createElement("button");
  exportBtn.className = "btn btn-secondary";
  exportBtn.textContent = "Export CSV";
  exportBtn.onclick = () => exportCsv();

  const rowInfo = document.createElement("span");
  rowInfo.id = "row-info";
  rowInfo.style.cssText = "font-size:11px;color:var(--text-muted);flex:1;";

  toolbar.appendChild(refreshBtn);
  toolbar.appendChild(exportBtn);
  toolbar.appendChild(rowInfo);
  tableMain.appendChild(toolbar);

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

  async function loadTableMetadata() {
    const ac2 = appState.activeConn.value;
    if (!ac2?.selectedTable) return;
    try {
      const [columns] = await ipc.describeTable(
        ac2.connId,
        schemaForEngine(),
        ac2.selectedTable,
      );
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

    rowInfo.textContent = "Loading…";

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

      if (rows.error) {
        rowInfo.textContent = `Error: ${rows.error}`;
        return;
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
    }
  }

  // ── CSV export ──────────────────────────────────────────────────────────
  async function exportCsv() {
    const s = appState.tableState.value;
    const ac2 = appState.activeConn.value;
    if (!ac2?.selectedTable) return;
    try {
      const result = await ipc.fetchTableRows(
        ac2.connId,
        ac2.selectedSchema,
        ac2.selectedTable,
        {
          limit: 10_000,
          offset: 0,
          order_by: s.orderBy,
          order_desc: s.orderDesc,
        },
        s.whereClause || undefined,
      );
      const lines = [
        result.columns.map((c) => csvCell(c.name)).join(","),
        ...result.rows.map((row) =>
          row.map((v) => csvCell(String(v ?? ""))).join(","),
        ),
      ];
      const blob = new Blob([lines.join("\n")], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${ac2.selectedTable}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Export failed: ${e}`);
    }
  }
}

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

  const pageSizeEl = document.createElement("span");
  pageSizeEl.style.cssText = "font-size:11px;color:var(--text-faint);";
  pageSizeEl.textContent = `${pageSize} / page`;

  el.appendChild(prev);
  el.appendChild(info);
  el.appendChild(next);
  el.appendChild(pageSizeEl);
}

function changePage(newPage: number) {
  if (!confirmDiscardIfDirty()) return;
  clearRecordSelection();
  const s = appState.tableState.value;
  appState.tableState.set({ ...s, page: newPage });
  renderActiveTabContent();
}

function showConnectionsScreen() {
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

async function connectToDb(cfg: ConnectionConfig) {
  appState.status.set(`Connecting: ${cfg.name}…`);
  statusDot.className = "status-dot";

  try {
    const connId = await ipc.connectDb(cfg);

    // Load databases, schemas, and tables in parallel
    const [databases, schemas, tables] = await Promise.all([
      ipc.listDatabases(connId).catch(() => [] as string[]),
      ipc.listSchemas(connId).catch(() => []),
      ipc.listTables(connId),
    ]);

    const defaultSchema =
      schemas.find((s) => s.name === "public" || s.name === "dbo")?.name ??
      schemas[0]?.name;

    // For engines without a database concept (SQLite), use the config's db name
    const selectedDb =
      cfg.database || (databases.length > 0 ? databases[0] : undefined);

    appState.activeConn.set({
      connId,
      config: cfg,
      databases,
      selectedDatabase: selectedDb,
      schemas,
      selectedSchema: defaultSchema,
      tables,
    });

    statusDot.className = "status-dot connected";
    appState.status.set(`Connected: ${cfg.name}`);

    // Fresh connection — ensure clean tab state
    resetTabsAndLiveState();

    renderSidebar();
    // Land on a usable default query tab, like TablePlus does on connect
    openQueryTab();
  } catch (e) {
    statusDot.className = "status-dot error";
    appState.status.set(`Error: ${e}`);
    alert(`Connection failed:\n${e}`);
  }
}

// ── Connection state subscription ─────────────────────────────────────────────

appState.connections.subscribe(() => {
  if (!appState.activeConn.value) renderSidebar();
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
  renderContentArea();
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

    if (tabs.length > 0) {
      const closeAllBtn = document.createElement("button");
      closeAllBtn.className = "table-tab-closeall";
      closeAllBtn.innerHTML = "&#10005;&#10005;";
      closeAllBtn.title = "Close all tabs";
      closeAllBtn.onclick = () => {
        if (!confirm(`Close all ${tabs.length} open tabs?`)) return;
        closeAllTabs();
      };
      tabStripEl.appendChild(closeAllBtn);
    }
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

  const existing = appState.openTabs.value.find(
    (t): t is TableTab =>
      t.kind === "table" &&
      t.connId === ac.connId &&
      t.name === tableName &&
      (t.schema ?? undefined) === (schema ?? undefined) &&
      (t.database ?? undefined) === (database ?? undefined),
  );

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
}

function closeAllTabs() {
  resetTabsAndLiveState();
  const ac = appState.activeConn.value;
  if (ac) appState.activeConn.set({ ...ac, selectedTable: undefined });
  renderActiveTabContent();
  renderTabStrip();
}

// Always create a brand new table tab (allows duplicates — e.g. two views of
// one table with different filters). Used from the sidebar when no matching
// tab already exists.
function openTableInNewTab(
  ac: ActiveConnection,
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
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function csvCell(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}
