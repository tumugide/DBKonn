import { ipc, type ConnectionConfig, type DbEngine } from "../lib/ipc";
import { appState } from "../lib/store";

function genId(): string {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

export function showConnectionModal(
  existing?: ConnectionConfig,
  onSaved?: () => void,
): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  const isEdit = !!existing;
  const initial: ConnectionConfig = existing ?? {
    id: genId(),
    name: "",
    engine: "postgres",
    host: "localhost",
    port: 5432,
    username: "",
    password: "",
    database: "",
    ssl_mode: "prefer",
  };

  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">${isEdit ? "EDIT" : "NEW"} CONNECTION</div>
      <div class="modal-body">

        <div class="form-row">
          <label>Connection Name</label>
          <input id="cm-name" type="text" value="${esc(initial.name)}"
                 placeholder="my-database" style="width:100%" />
        </div>

        <div class="form-row">
          <label>Engine</label>
          <select id="cm-engine" style="width:100%">
            <option value="postgres" ${initial.engine === "postgres" ? "selected" : ""}>PostgreSQL</option>
            <option value="mysql"    ${initial.engine === "mysql" ? "selected" : ""}>MySQL / MariaDB</option>
            <option value="sqlite"   ${initial.engine === "sqlite" ? "selected" : ""}>SQLite</option>
            <option value="mssql"    ${initial.engine === "mssql" ? "selected" : ""}>SQL Server (MSSQL)</option>
          </select>
        </div>

        <div id="cm-net-fields">
          <div class="form-row-2">
            <div>
              <label>Host</label>
              <input id="cm-host" type="text" value="${esc(initial.host ?? "localhost")}" style="width:100%" />
            </div>
            <div>
              <label>Port</label>
              <input id="cm-port" type="number" value="${initial.port ?? 5432}" style="width:100%" />
            </div>
          </div>
          <div class="form-row-2">
            <div>
              <label>Username</label>
              <input id="cm-user" type="text" value="${esc(initial.username ?? "")}" style="width:100%" />
            </div>
            <div>
              <label>Password</label>
              <input id="cm-pass" type="password" value="${esc(initial.password ?? "")}"
                     placeholder="stored in Keychain" style="width:100%" />
            </div>
          </div>
          <div class="form-row">
            <label>Database</label>
            <input id="cm-db" type="text" value="${esc(initial.database ?? "")}" style="width:100%" />
          </div>
          <div class="form-row">
            <label>SSL Mode</label>
            <select id="cm-ssl" style="width:100%">
              <option value="prefer"  ${initial.ssl_mode === "prefer" ? "selected" : ""}>PREFER</option>
              <option value="require" ${initial.ssl_mode === "require" ? "selected" : ""}>REQUIRE</option>
              <option value="disable" ${initial.ssl_mode === "disable" ? "selected" : ""}>DISABLE</option>
            </select>
          </div>
        </div>

        <div id="cm-sqlite-fields" style="display:none">
          <div class="form-row">
            <label>File Path</label>
            <input id="cm-filepath" type="text" value="${esc(initial.file_path ?? "")}"
                   placeholder="/path/to/database.sqlite" style="width:100%" />
          </div>
        </div>

        <div id="cm-status" style="font-size:11px;min-height:16px;margin-top:4px;font-family:var(--font-mono);"></div>

      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cm-test">TEST CONN</button>
        <button class="btn btn-secondary" id="cm-cancel">CANCEL</button>
        <button class="btn btn-primary" id="cm-save">SAVE</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const engineSel = overlay.querySelector<HTMLSelectElement>("#cm-engine")!;
  const netFields = overlay.querySelector<HTMLElement>("#cm-net-fields")!;
  const sqliteFields = overlay.querySelector<HTMLElement>("#cm-sqlite-fields")!;
  const portInput = overlay.querySelector<HTMLInputElement>("#cm-port")!;
  const statusEl = overlay.querySelector<HTMLElement>("#cm-status")!;

  const DEFAULT_PORTS: Record<DbEngine, number> = {
    postgres: 5432,
    mysql: 3306,
    sqlite: 0,
    mssql: 1433,
  };

  engineSel.addEventListener("change", () => {
    const eng = engineSel.value as DbEngine;
    const isSqlite = eng === "sqlite";
    netFields.style.display = isSqlite ? "none" : "";
    sqliteFields.style.display = isSqlite ? "" : "none";
    if (!isSqlite) portInput.value = String(DEFAULT_PORTS[eng]);
  });

  function buildConfig(): ConnectionConfig {
    const eng = engineSel.value as DbEngine;
    const isSqlite = eng === "sqlite";
    return {
      id: initial.id,
      name: overlay.querySelector<HTMLInputElement>("#cm-name")!.value.trim(),
      engine: eng,
      host: isSqlite
        ? undefined
        : overlay.querySelector<HTMLInputElement>("#cm-host")!.value ||
          undefined,
      port: isSqlite ? undefined : Number(portInput.value) || undefined,
      username: isSqlite
        ? undefined
        : overlay.querySelector<HTMLInputElement>("#cm-user")!.value ||
          undefined,
      password: isSqlite
        ? undefined
        : overlay.querySelector<HTMLInputElement>("#cm-pass")!.value ||
          undefined,
      database: isSqlite
        ? undefined
        : overlay.querySelector<HTMLInputElement>("#cm-db")!.value || undefined,
      file_path: isSqlite
        ? overlay.querySelector<HTMLInputElement>("#cm-filepath")!.value ||
          undefined
        : undefined,
      ssl_mode: isSqlite
        ? "disable"
        : (overlay.querySelector<HTMLSelectElement>("#cm-ssl")!.value as any),
    };
  }

  overlay.querySelector("#cm-test")!.addEventListener("click", async () => {
    setStatus("TESTING CONNECTION...", "color:var(--text-muted)");
    try {
      await ipc.testConnection(buildConfig());
      setStatus("[ OK ] CONNECTION SUCCESSFUL", "color:var(--accent-green)");
    } catch (e) {
      setStatus(`[ !! ] ${e}`, "color:var(--accent-amber)");
    }
  });

  overlay.querySelector("#cm-save")!.addEventListener("click", async () => {
    const cfg = buildConfig();
    if (!cfg.name) {
      setStatus("NAME IS REQUIRED", "color:var(--accent-amber)");
      return;
    }
    try {
      await ipc.saveConnection(cfg);
      const all = await ipc.loadConnections();
      appState.connections.set(all);
      overlay.remove();
      onSaved?.();
    } catch (e) {
      setStatus(`ERROR: ${e}`, "color:var(--accent-red)");
    }
  });

  overlay
    .querySelector("#cm-cancel")!
    .addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  function setStatus(msg: string, style: string) {
    statusEl.textContent = msg;
    statusEl.setAttribute(
      "style",
      `font-size:11px;min-height:16px;margin-top:4px;${style}`,
    );
  }
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}
