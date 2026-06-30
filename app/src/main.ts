import "./styles/global.css";
import { ipc, type ConnectionConfig, type ColumnInfo } from "./lib/ipc";
import { appState, type MainView } from "./lib/store";
import { DataGrid } from "./components/DataGrid";
import { FilterBar } from "./components/FilterBar";
import { SqlEditor } from "./components/SqlEditor";
import { RecordPanel } from "./components/RecordPanel";
import { showConnectionModal } from "./components/ConnectionModal";
import { cloneRowValue } from "./lib/rowEdit";
import type { RowValue } from "./lib/ipc";

// ── App Shell ─────────────────────────────────────────────────────────────────

const app = document.getElementById("app")!;

app.innerHTML = `
  <div class="titlebar">
    <div class="window-controls"></div>
    <span class="title">&gt;&gt; DBKONN v0.1</span>
  </div>
  <div class="app-layout">
    <aside class="sidebar" id="sidebar"></aside>
    <div class="main-area">
      <div class="tab-bar">
        <div class="tab active" data-view="table">[ DATA ]</div>
        <div class="tab" data-view="sql">[ SQL ]</div>
        <div class="tab" data-view="connections">[ CONNECTIONS ]</div>
      </div>
      <div id="main-content" style="flex:1;overflow:hidden;display:flex;flex-direction:column;"></div>
    </div>
  </div>
  <div class="status-bar">
    <div class="status-dot" id="status-dot"></div>
    <span id="status-text">READY</span>
    <span style="margin-left:auto;color:var(--green-ghost)">DBKonn © 2025</span>
  </div>
`;

// ── Element refs ──────────────────────────────────────────────────────────────
const sidebarEl = document.getElementById("sidebar")!;
const mainContent = document.getElementById("main-content")!;
const statusText = document.getElementById("status-text")!;
const statusDot = document.getElementById("status-dot")!;

appState.status.subscribe((s) => {
  statusText.textContent = s.toUpperCase();
});

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document
      .querySelectorAll(".tab")
      .forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const view = (tab as HTMLElement).dataset["view"] as MainView;
    appState.mainView.set(view);
    renderMainView(view);
  });
});

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
        selectTable(tableName, ac.selectedSchema);
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
    listEl.innerHTML = `<div style="padding:12px 8px;color:var(--green-ghost);font-size:11px;">
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
    renderSidebar();
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
  statusDot.className = "status-dot";
  appState.status.set("DISCONNECTED");
  renderSidebar();
  renderMainView("connections");
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
  rowInfo.style.cssText = "font-size:11px;color:var(--green-dim);flex:1;";

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
      await loadTableData();
    },
    ac.config.engine,
  );

  if (appState.tableMetadata.value.length > 0) {
    filterBar.setColumns(appState.tableMetadata.value);
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
  pageSizeEl.style.cssText = "font-size:11px;color:var(--green-ghost);";
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
    empty.innerHTML = `<p style="color:var(--green-ghost)">NO CONNECTIONS CONFIGURED.</p>`;
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

    renderSidebar();

    // Switch to data view
    document
      .querySelectorAll(".tab")
      .forEach((t) => t.classList.remove("active"));
    document.querySelector('[data-view="table"]')?.classList.add("active");
    appState.mainView.set("table");
    renderMainView("table");
  } catch (e) {
    statusDot.className = "status-dot error";
    appState.status.set(`ERROR: ${e}`);
    alert(`Connection failed:\n${e}`);
  }
}

// ── Select a table ────────────────────────────────────────────────────────────

function selectTable(tableName: string, schema?: string) {
  const ac = appState.activeConn.value;
  if (!ac) return;

  appState.activeConn.set({
    ...ac,
    selectedTable: tableName,
    selectedSchema: schema,
  });
  appState.tableState.set({
    totalRows: 0,
    page: 0,
    pageSize: 100,
    orderDesc: false,
    whereClause: "",
    loading: false,
    columns: [],
    orderBy: undefined,
  });
  appState.tableMetadata.set([]);
  appState.selectedRecord.set(null);

  // Re-render sidebar to highlight selected table
  renderSidebar();

  // Switch to table view
  document
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.remove("active"));
  document.querySelector('[data-view="table"]')?.classList.add("active");
  appState.mainView.set("table");
  renderMainView("table");
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
  renderMainView("connections");
}

boot();

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
