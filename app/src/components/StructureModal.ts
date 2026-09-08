import type { AlterRequest, ColumnInfo, IndexInfo } from "../lib/ipc";
import { wireModalDismissal } from "../lib/modal";
import { escapeHtml as esc } from "../lib/escape";

type AlterFn = (request: AlterRequest) => Promise<void>;

function columnsTable(columns: ColumnInfo[]): string {
  if (columns.length === 0) return `<p class="structure-empty">No columns.</p>`;
  const rows = columns
    .map(
      (c) => `
      <tr>
        <td>${esc(c.name)}${c.is_primary_key ? ' <span class="structure-badge">PK</span>' : ""}</td>
        <td>${esc(c.data_type)}${c.max_length ? `(${c.max_length})` : ""}</td>
        <td>${c.nullable ? "YES" : "NO"}</td>
        <td>${c.default_value != null ? esc(c.default_value) : "—"}</td>
      </tr>`,
    )
    .join("");
  return `
    <table class="structure-table">
      <thead><tr><th>Column</th><th>Type</th><th>Nullable</th><th>Default</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function indexesTable(indexes: IndexInfo[]): string {
  if (indexes.length === 0) return `<p class="structure-empty">No indexes.</p>`;
  const rows = indexes
    .map(
      (ix) => `
      <tr>
        <td>${esc(ix.name)}</td>
        <td>${ix.columns.map(esc).join(", ")}</td>
        <td>${ix.is_unique ? "YES" : "NO"}</td>
        <td>${ix.is_primary ? "YES" : "NO"}</td>
      </tr>`,
    )
    .join("");
  return `
    <table class="structure-table">
      <thead><tr><th>Index</th><th>Columns</th><th>Unique</th><th>Primary</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

export interface StructureEditorOptions {
  tableLabel: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  engine: string;
  /** Runs a structure mutation; resolves once the backend confirms (and the
   *  caller has refreshed metadata). Rejects with the error message. */
  onAlter: AlterFn;
  /** User-agent-defined reload of columns + indexes (typically re-invoking
   *  `describeTable` and then reopening this modal with fresh data). */
  onReload: () => Promise<Partial<StructureEditorOptions>>;
}

export function showStructureModal(opts: StructureEditorOptions): void {
  const { tableLabel, columns, indexes, engine, onAlter, onReload } = opts;

  const infosWithActions = (infos: { name: string; data: string }[]) =>
    infos.map((i) => `<option value="${esc(i.name)}">${esc(i.data)}</option>`).join("");

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal modal-wide" aria-label="Structure of ${esc(tableLabel)}">
      <div class="modal-title">Structure — ${esc(tableLabel)}</div>
      <div class="modal-body structure-body">
        <h3 class="structure-heading">Columns <span>${columns.length}</span></h3>
        ${columnsTable(columns)}
        <h3 class="structure-heading">Indexes <span>${indexes.length}</span></h3>
        ${indexesTable(indexes)}

        <h3 class="structure-heading">Add column</h3>
        <div class="structure-editor">
          <div class="form-row">
            <label>Name</label>
            <input id="sc-name" type="text" placeholder="column_name (letters, numbers, _)">
          </div>
          <div class="form-row">
            <label>Type</label>
            <input id="sc-type" type="text" placeholder="VARCHAR(255), INTEGER, TIMESTAMPTZ…" spellcheck="false">
          </div>
          <div class="form-row-2">
            <div class="form-row">
              <label>Default</label>
              <input id="sc-default" type="text" placeholder="e.g. 0, now(), 'active'">
            </div>
            <div class="form-row">
              <label class="structure-check">
                <input id="sc-null" type="checkbox"> Nullable
              </label>
            </div>
          </div>
          <div class="structure-actions">
            <button class="btn btn-secondary" id="sc-add">Add column</button>
            <span id="sc-add-msg" class="structure-msg"></span>
          </div>
        </div>

        <h3 class="structure-heading">Rename column</h3>
        <div class="structure-editor">
          <div class="form-row-2">
            <div class="form-row">
              <label>Current</label>
              <select id="sc-rename-from">
                <option value="">Select a column…</option>
                ${infosWithActions(columns.map((c) => ({ name: c.name, data: `${c.name} (${c.data_type})` })))}
              </select>
            </div>
            <div class="form-row">
              <label>New name</label>
              <input id="sc-rename-to" type="text" placeholder="new_name">
            </div>
          </div>
          <div class="structure-actions">
            <button class="btn btn-secondary" id="sc-rename">Rename</button>
            <span id="sc-rename-msg" class="structure-msg"></span>
          </div>
        </div>

        <h3 class="structure-heading">Drop column</h3>
        <div class="structure-editor">
          <div class="form-row">
            <label>Column</label>
            <select id="sc-drop-col">
              <option value="">Select a column…</option>
              ${infosWithActions(columns.filter((c) => !c.is_primary_key).map((c) => ({ name: c.name, data: `${c.name} (${c.data_type})` })))}
            </select>
          </div>
          <div class="structure-actions">
            <button class="btn btn-danger" id="sc-drop-col-btn">Drop column</button>
            <span id="sc-drop-col-msg" class="structure-msg"></span>
          </div>
        </div>

        <h3 class="structure-heading">Create index</h3>
        <div class="structure-editor">
          <div class="form-row">
            <label>Name</label>
            <input id="sc-ix-name" type="text" placeholder="index_name">
          </div>
          <div class="form-row">
            <label>Columns (comma-separated)</label>
            <input id="sc-ix-cols" type="text" placeholder="col1, col2, col3">
          </div>
          <div class="form-row">
            <label class="structure-check">
              <input id="sc-ix-unique" type="checkbox"> Unique
            </label>
          </div>
          <div class="structure-actions">
            <button class="btn btn-secondary" id="sc-ix-add">Create index</button>
            <span id="sc-ix-add-msg" class="structure-msg"></span>
          </div>
        </div>

        <h3 class="structure-heading">Drop index</h3>
        <div class="structure-editor">
          <div class="form-row">
            <label>Index</label>
            <select id="sc-drop-ix">
              <option value="">Select an index…</option>
              ${infosWithActions(indexes.map((i) => ({ name: i.name, data: `${i.name} (${i.columns.join(", ")})` })))}
            </select>
          </div>
          <div class="structure-actions">
            <button class="btn btn-danger" id="sc-drop-ix-btn">Drop index</button>
            <span id="sc-drop-ix-msg" class="structure-msg"></span>
          </div>
        </div>
      </div>
      <div class="modal-actions">
        <span id="sc-status" class="structure-msg structure-status"></span>
        <button class="btn btn-secondary" id="structure-refresh">Refresh</button>
        <button class="btn btn-secondary" id="structure-close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector(sel) as unknown as T;
  const msg = (id: string, text: string, ok = true) => {
    const el = $(id);
    el.textContent = text;
    el.className = `structure-msg ${ok ? "" : "structure-msg-error"}`;
  };

  // Reload columns/indexes and reopen the modal in place with fresh data.
  // Used by both the manual Refresh button and after any successful mutation.
  const reload = () => {
    void (async () => {
      msg("sc-status", "Refreshing…");
      try {
        const fresh = await onReload();
        overlay.remove();
        showStructureModal({ ...opts, ...fresh, engine, onAlter, onReload });
      } catch (e) {
        msg("sc-status", String(e), false);
      }
    })();
  };

  const run = async (request: AlterRequest, msgId: string, thenRefresh: boolean) => {
    msg(msgId, "Working…");
    try {
      await onAlter(request);
      msg(msgId, "Done.");
      if (thenRefresh) reload();
    } catch (e) {
      msg(msgId, String(e), false);
    }
  };

  $<HTMLButtonElement>("#sc-add").addEventListener("click", () => {
    const name = $<HTMLInputElement>("#sc-name").value.trim();
    const data_type = $<HTMLInputElement>("#sc-type").value.trim();
    const default_value = $<HTMLInputElement>("#sc-default").value.trim();
    const nullable = $<HTMLInputElement>("#sc-null").checked;
    if (!name || !data_type) {
      msg("sc-add-msg", "Name and type are required.", false);
      return;
    }
    void run(
      { op: "add_column", name, data_type, nullable, default_value: default_value || undefined },
      "sc-add-msg",
      true,
    );
  });

  $<HTMLButtonElement>("#sc-rename").addEventListener("click", () => {
    const old_name = $<HTMLSelectElement>("#sc-rename-from").value;
    const new_name = $<HTMLInputElement>("#sc-rename-to").value.trim();
    if (!old_name || !new_name) {
      msg("sc-rename-msg", "Pick a column and enter the new name.", false);
      return;
    }
    void run({ op: "rename_column", old_name, new_name }, "sc-rename-msg", true);
  });

  $<HTMLButtonElement>("#sc-drop-col-btn").addEventListener("click", () => {
    const name = $<HTMLSelectElement>("#sc-drop-col").value;
    if (!name) {
      msg("sc-drop-col-msg", "Select a column to drop.", false);
      return;
    }
    if (!confirm(`Drop column ${name} from ${tableLabel}? This cannot be undone.`)) return;
    void run({ op: "drop_column", name }, "sc-drop-col-msg", true);
  });

  $<HTMLButtonElement>("#sc-ix-add").addEventListener("click", () => {
    const name = $<HTMLInputElement>("#sc-ix-name").value.trim();
    const columnsRaw = $<HTMLInputElement>("#sc-ix-cols").value;
    const columns = columnsRaw.split(",").map((c) => c.trim()).filter(Boolean);
    const unique = $<HTMLInputElement>("#sc-ix-unique").checked;
    if (!name || columns.length === 0) {
      msg("sc-ix-add-msg", "Enter a name and at least one column.", false);
      return;
    }
    void run({ op: "create_index", name, columns, unique }, "sc-ix-add-msg", true);
  });

  $<HTMLButtonElement>("#sc-drop-ix-btn").addEventListener("click", () => {
    const name = $<HTMLSelectElement>("#sc-drop-ix").value;
    if (!name) {
      msg("sc-drop-ix-msg", "Select an index to drop.", false);
      return;
    }
    if (!confirm(`Drop index ${name} from ${tableLabel}? This cannot be undone.`)) return;
    void run({ op: "drop_index", name }, "sc-drop-ix-msg", true);
  });

  $<HTMLButtonElement>("#structure-refresh").addEventListener("click", reload);

  const close = () => overlay.remove();
  wireModalDismissal(overlay, close);
  overlay.querySelector<HTMLButtonElement>("#structure-close")!.addEventListener("click", close);
}
