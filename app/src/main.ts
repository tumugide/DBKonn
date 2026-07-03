import "./styles/global.css";
import { ipc, type ConnectionConfig, type ColumnInfo } from "./lib/ipc";
import { appState, type MainView, type ThemeType, type OpenTableTab, type TableState, type ActiveConnection, THEMES } from "./lib/store";
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
      <div class="modal-title">[ APPEARANCE ]</div>
      <div class="modal-body">
        <p style="font-size:11px;color:var(--text-muted);margin-bottom:12px;letter-spacing:0.05em;">
          SELECT THEME
        </p>
        <div class="theme-grid">
          ${themeKeys.map((key) => {
            const meta = THEMES[key];
            const active = key === currentTheme ? " active" : "";
            return `<button class="theme-option${active}" data-theme-key="${key}">
              <span class="dot" style="background:var(--accent)"></span>
              ${meta.label}
              ${active ? '<span class="current-badge">CURRENT</span>' : ""}
            </button>`;
          }).join("")}
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="am-close">CLOSE</button>
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
    <div class="window-controls"></div>
    <span class="title">&gt;&gt; DBKONN v0.1</span>
    <div class="titlebar-spacer"></div>
    <div class="titlebar-center">
      <button class="view-btn" id="btn-view-sql" data-view="sql">[ SQL ]</button>
      <button class="view-btn" id="btn-view-connections" data-view="connections">[ CONNECTIONS ]</button>
    </div>
    <div class="titlebar-spacer"></div>
    <button class="btn-icon" id="btn-appearance" title="Appearance settings" style="border:none;font-size:12px;">[THEME]</button>
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
    <button class="view-btn" id="btn-view-data" data-view="table">[ DATA ]</button>
    <span id="status-text">READY</span>
    <span id="theme-label" style="margin-left:auto;cursor:pointer;color:var(--text-muted);letter-spacing:0.06em;font-weight:700;" title="Click to change theme"></span>
    <span style="margin-left:8px;color:var(--text-faint)">DBKonn © 2025</span>
  </div>
`;

// ── Element refs ──────────────────────────────────────────────────────────────
const sidebarEl = document.getElementById("sidebar")!;
const mainContent = document.getElementById("tab-content-area")!;
const statusText = document.getElementById("status-text")!;
const statusDot = document.getElementById("status-dot")!;
const themeLabel = document.getElementById("theme-label")!;
const tableTabsList = document.getElementById("table-tabs-list")!;

appState.status.subscribe((s) => {
  statusText.textContent = s.toUpperCase();
});

// ── Theme: apply on boot, listen for changes ──────────────────────────────────
const savedTheme = loadSavedTheme();
appState.theme.set(savedTheme);
applyTheme(savedTheme);
appState.theme.subscribe(applyTheme);

document.getElementById("btn-appearance")!.addEventListener("click", showAppearanceModal);
themeLabel.addEventListener("click", showAppearanceModal);

// ── View switchers (SQL / Connections in titlebar, DATA in status bar) ─────────
function setActiveView(view: MainView) {
  document.querySelectorAll(".view-btn").forEach((btn) => {
    const v = (btn as HTMLElement).dataset["view"];
    btn.classList.toggle("active", v === view);
  });
}

function switchView(view: MainView) {
  appState.mainView.set(view);
  renderMainView(view);
}

document.querySelectorAll(".view-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const view = (btn as HTMLElement).dataset["view"] as MainView;
    switchView(view);
  });
});

appState.mainView.subscribe((v) => setActiveView(v));
setActiveView(appState.mainView.value);

// ── Table-tab controls (+ / close-all) ─────────────────────────────────────────
// Wired inside renderTableTabs() since the strip is re-rendered.

// ── Sidebar ───────────────────────────────────────────────────────────────────

function renderSidebar() {
  const ac = appState.activeConn.value;
  const buf: string[] = [];

  if (ac) {
    // ── Connected mode ─────────────────────────────────────────────────────
    const eng = ac.config.engine.toUpperCase().slice(0, 2);
    buf.push(`
      <div class="sidebar-header connected">
        <span>[${eng}] ${esc(ac.config.name)}</span>
        <button class="btn-icon danger" id="sb-disconnect" title="Disconnect">QUIT</button>
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
          <label>SCH</label>
          <select id="sb-schema-select">${schemas}</select>
        </div>
      `);
    }

    buf.push(`</div>`);

    // Table tree
    buf.push(`<div class="tree-header">TABLES [${ac.tables.length}]</div>`);
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
        <span>CONNECTIONS</span>
        <button class="btn-icon" id="sb-new-conn">+</button>
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
      No connections.<br>Press [+] to add one.
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
    appState.openTableTabs.set([]);
    appState.activeTableTab.set(null);
    appState.tableState.set(freshTableState());
    appState.tableMetadata.set([]);
    appState.selectedRecord.set(null);
    appState.filterRules.set([]);
    renderSidebar();
    renderTableTabs();
    renderMainView(appState.mainView.value);
  } catch (e) {
    appState.status.set(`ERROR: ${e}`);
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
    // Stay on current view but clear table selection
    renderMainView(appState.mainView.value);
  } catch (e) {
    appState.status.set(`ERROR: ${e}`);
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
  // Tabs are tied to a connection — drop them all
  appState.openTableTabs.set([]);
  appState.activeTableTab.set(null);
  appState.tableState.set(freshTableState());
  appState.tableMetadata.set([]);
  appState.selectedRecord.set(null);
  appState.filterRules.set([]);
  statusDot.className = "status-dot";
  appState.status.set("DISCONNECTED");
  renderSidebar();
  renderTableTabs();
  switchView("connections");
}

// ── Main views ────────────────────────────────────────────────────────────────

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

function renderMainView(view: MainView) {
  mainContent.innerHTML = "";
  mainContent.style.overflow = "";
  mainContent.style.padding = "";

  if (view === "sql") {
    renderSqlView();
  } else if (view === "table") {
    renderTableView();
  } else {
    renderConnectionsView();
  }
}

function renderSqlView() {
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "flex:1;overflow:hidden;display:flex;flex-direction:column;height:100%;";
  mainContent.appendChild(wrap);

  sqlEditor = new SqlEditor(wrap);

  const ac = appState.activeConn.value;
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

function renderTableView() {
  const ac = appState.activeConn.value;
  if (!ac?.selectedTable) {
    mainContent.innerHTML = `
      <div class="empty-state">
        <pre>
+----------------------------------+
|  NO TABLE SELECTED               |
|                                  |
|  Connect and pick a table from   |
|  the sidebar to browse data.     |
+----------------------------------+
        </pre>
      </div>`;
    return;
  }

  const ts = appState.tableState.value;
  const selected = appState.selectedRecord.value;

  mainContent.innerHTML = "";
  mainContent.style.cssText =
    "flex:1;overflow:hidden;display:flex;flex-direction:column;";

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
  refreshBtn.textContent = "[F5] REFRESH";
  refreshBtn.onclick = () => {
    if (!confirmDiscardIfDirty()) return;
    clearRecordSelection();
    void loadTableData();
  };

  const exportBtn = document.createElement("button");
  exportBtn.className = "btn btn-secondary";
  exportBtn.textContent = "EXPORT CSV";
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
        `UPDATED ${result.affected_rows ?? 1} ROW(S) | ${result.execution_time_ms}ms`,
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

    rowInfo.textContent = "LOADING...";

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
        rowInfo.textContent = `ERROR: ${rows.error}`;
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
      rowInfo.textContent = `ROWS ${start}-${end} OF ${total} | ${rows.execution_time_ms}ms`;
      renderPagination(pagination, total, s.page, s.pageSize);
    } catch (e) {
      rowInfo.textContent = `ERROR: ${e}`;
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
  prev.textContent = "[<< PREV]";
  prev.disabled = page === 0;
  prev.onclick = () => changePage(page - 1);

  const info = document.createElement("span");
  info.className = "page-info";
  info.textContent = `PAGE ${page + 1} / ${totalPages}`;

  const next = document.createElement("button");
  next.className = "btn btn-secondary";
  next.textContent = "[NEXT >>]";
  next.disabled = page >= totalPages - 1;
  next.onclick = () => changePage(page + 1);

  const pageSizeEl = document.createElement("span");
  pageSizeEl.style.cssText = "font-size:11px;color:var(--text-faint);";
  pageSizeEl.textContent = `${pageSize}/PAGE`;

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
  renderMainView("table");
}

function renderConnectionsView() {
  mainContent.style.overflow = "auto";
  mainContent.style.padding = "20px";

  const conns = appState.connections.value;

  const heading = document.createElement("div");
  heading.className = "section-heading";
  heading.innerHTML = `<h2>&gt;&gt; SAVED CONNECTIONS</h2>`;

  const addBtn = document.createElement("button");
  addBtn.className = "btn btn-primary";
  addBtn.textContent = "[+] NEW CONNECTION";
  addBtn.onclick = () =>
    showConnectionModal(undefined, () => {
      renderConnectionsView();
      renderSidebar();
    });
  heading.appendChild(addBtn);
  mainContent.appendChild(heading);

  if (conns.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.style.marginTop = "40px";
    empty.innerHTML = `<p style="color:var(--text-faint)">NO CONNECTIONS CONFIGURED.</p>`;
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
        <div class="conn-card-name">[${cfg.engine.slice(0, 2).toUpperCase()}] ${esc(cfg.name)}</div>
        <div class="conn-card-detail">${esc(detail.join(" "))}</div>
      </div>
      <div class="conn-card-actions"></div>
    `;

    const actions = card.querySelector(".conn-card-actions")!;

    const connectBtn = document.createElement("button");
    connectBtn.className = "btn btn-primary";
    connectBtn.textContent = "CONNECT";
    connectBtn.onclick = () => connectToDb(cfg);

    const editBtn = document.createElement("button");
    editBtn.className = "btn btn-secondary";
    editBtn.textContent = "EDIT";
    editBtn.onclick = () =>
      showConnectionModal(cfg, () => renderConnectionsView());

    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-danger";
    delBtn.textContent = "DEL";
    delBtn.onclick = async () => {
      if (!confirm(`Delete connection "${cfg.name}"?`)) return;
      try {
        await ipc.deleteConnection(cfg.id);
        const all = await ipc.loadConnections();
        appState.connections.set(all);
        renderConnectionsView();
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
  appState.status.set(`CONNECTING: ${cfg.name}…`);
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
    appState.status.set(`CONNECTED: ${cfg.name}`);

    // Fresh connection — ensure clean tab state
    appState.openTableTabs.set([]);
    appState.activeTableTab.set(null);
    appState.tableState.set(freshTableState());
    appState.tableMetadata.set([]);
    appState.selectedRecord.set(null);
    appState.filterRules.set([]);

    renderSidebar();
    renderTableTabs();

    // Switch to data view (setActiveView runs via the mainView subscription)
    switchView("table");
  } catch (e) {
    statusDot.className = "status-dot error";
    appState.status.set(`ERROR: ${e}`);
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
  renderTableTabs();
  switchView("connections");
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

// Persist the live signals back into the currently-active tab so switching away
// preserves its filters / sort / page / selected record.
function persistCurrentTabState() {
  const activeId = appState.activeTableTab.value;
  if (!activeId) return;
  const tabs = appState.openTableTabs.value;
  const idx = tabs.findIndex((t) => t.id === activeId);
  if (idx === -1) return;
  const tab = tabs[idx]!;
  const updated: OpenTableTab = {
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
  const next = [...tabs];
  next[idx] = updated;
  appState.openTableTabs.set(next);
}

// Restore a tab's stored state into the global signals so renderTableView can
// operate on them unchanged.
function loadTabStateIntoSignals(tab: OpenTableTab) {
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

function renderTableTabs() {
  const tabs = appState.openTableTabs.value;
  const activeTabId = appState.activeTableTab.value;

  tableTabsList.innerHTML = "";
  tableTabsList.className = "table-tab-strip";

  // Trailing controls: [+] new tab and [close-all]
  const appendTrailingControls = () => {
    const newTabBtn = document.createElement("button");
    newTabBtn.className = "table-tab-add";
    newTabBtn.innerHTML = "+";
    newTabBtn.title = "Open / focus table tab";
    newTabBtn.onclick = () => {
      const ac = appState.activeConn.value;
      if (!ac) return;
      if (ac.selectedTable) {
        openOrCreateTableTab(ac.selectedTable, ac.selectedSchema, ac.selectedDatabase);
      } else {
        appState.status.set("SELECT A TABLE FIRST");
      }
    };
    tableTabsList.appendChild(newTabBtn);

    if (tabs.length > 0) {
      const closeAllBtn = document.createElement("button");
      closeAllBtn.className = "table-tab-closeall";
      closeAllBtn.innerHTML = "&#10005;&#10005;";
      closeAllBtn.title = "Close all tabs";
      closeAllBtn.onclick = () => {
        if (!confirm(`Close all ${tabs.length} open tabs?`)) return;
        closeAllTableTabs();
      };
      tableTabsList.appendChild(closeAllBtn);
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
    item.title = `${tab.schema ? tab.schema + "." : ""}${tab.name}`;
    item.onclick = () => switchToTableTab(tab.id);

    const label = document.createElement("span");
    label.className = "table-tab-label";
    label.textContent = tab.name;

    const closeBtn = document.createElement("button");
    closeBtn.className = "table-tab-close";
    closeBtn.innerHTML = "&#10005;";
    closeBtn.title = "Close tab";
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      closeTableTab(tab.id);
    };

    item.appendChild(label);
    item.appendChild(closeBtn);
    tableTabsList.appendChild(item);
  });

  appendTrailingControls();
}

// Reuse an existing tab for the same table/schema/database/conn, else create.
function openOrCreateTableTab(tableName: string, schema?: string, database?: string) {
  const ac = appState.activeConn.value;
  if (!ac) return;

  const existing = appState.openTableTabs.value.find(
    (t) =>
      t.connId === ac.connId &&
      t.name === tableName &&
      (t.schema ?? undefined) === (schema ?? undefined) &&
      (t.database ?? undefined) === (database ?? undefined),
  );

  if (existing) {
    switchToTableTab(existing.id);
    return;
  }

  openTableInNewTab(ac, tableName, schema, database);
}

function switchToTableTab(tabId: string) {
  const tabs = appState.openTableTabs.value;
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;

  // Save the outgoing tab's live state first
  persistCurrentTabState();

  appState.activeTableTab.set(tabId);

  const ac = appState.activeConn.value;
  if (!ac) return;

  appState.activeConn.set({
    ...ac,
    selectedTable: tab.name,
    selectedSchema: tab.schema ?? ac.selectedSchema,
    selectedDatabase: tab.database ?? ac.selectedDatabase,
  });

  loadTabStateIntoSignals(tab);
  renderTableTabs();
  renderMainView("table");
}

function closeTableTab(tabId: string) {
  const tabs = appState.openTableTabs.value;
  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;

  // If closing the active tab that has unsaved edits, ask first
  if (
    appState.activeTableTab.value === tabId &&
    appState.selectedRecord.value?.dirty &&
    !confirm("Discard unsaved changes in this tab?")
  ) {
    return;
  }

  const wasActive = appState.activeTableTab.value === tabId;
  const newTabs = tabs.filter((t) => t.id !== tabId);
  appState.openTableTabs.set(newTabs);

  if (wasActive) {
    // Pick a neighbor to activate
    if (newTabs.length > 0) {
      const nextIdx = Math.min(idx, newTabs.length - 1);
      const nextTab = newTabs[nextIdx]!;
      appState.activeTableTab.set(nextTab.id);
      const ac = appState.activeConn.value;
      if (ac) {
        appState.activeConn.set({
          ...ac,
          selectedTable: nextTab.name,
          selectedSchema: nextTab.schema ?? ac.selectedSchema,
          selectedDatabase: nextTab.database ?? ac.selectedDatabase,
        });
        loadTabStateIntoSignals(nextTab);
        renderMainView("table");
      }
    } else {
      appState.activeTableTab.set(null);
      // No tabs left — reset table signals to a clean state
      appState.tableState.set(freshTableState());
      appState.tableMetadata.set([]);
      appState.selectedRecord.set(null);
      appState.filterRules.set([]);
      const ac = appState.activeConn.value;
      if (ac) {
        appState.activeConn.set({ ...ac, selectedTable: undefined });
        renderMainView("table");
      }
    }
  }

  renderTableTabs();
}

function closeAllTableTabs() {
  appState.openTableTabs.set([]);
  appState.activeTableTab.set(null);
  appState.tableState.set(freshTableState());
  appState.tableMetadata.set([]);
  appState.selectedRecord.set(null);
  appState.filterRules.set([]);
  const ac = appState.activeConn.value;
  if (ac) {
    appState.activeConn.set({ ...ac, selectedTable: undefined });
    renderMainView("table");
  }
  renderTableTabs();
}

// Always create a brand new tab (allows duplicates — e.g. two views of one table
// with different filters). Used by the [+] button.
function openTableInNewTab(
  ac: ActiveConnection,
  tableName: string,
  schema?: string,
  database?: string,
) {
  // Save the outgoing tab's state before replacing the live signals
  persistCurrentTabState();

  const tab: OpenTableTab = {
    id: generateTabId(),
    name: tableName,
    schema: schema ?? ac.selectedSchema,
    database: database ?? ac.selectedDatabase,
    connId: ac.connId,
    tableState: freshTableState(),
    tableMetadata: [],
    selectedRecord: null,
    filterRules: [],
  };

  appState.openTableTabs.set([...appState.openTableTabs.value, tab]);
  appState.activeTableTab.set(tab.id);

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

  renderTableTabs();
  renderMainView("table");
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
