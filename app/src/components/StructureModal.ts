import type { ColumnInfo, IndexInfo } from "../lib/ipc";
import { wireModalDismissal } from "../lib/modal";

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

export function showStructureModal(
  tableLabel: string,
  columns: ColumnInfo[],
  indexes: IndexInfo[],
): void {
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
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="structure-close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  wireModalDismissal(overlay, close);
  overlay.querySelector("#structure-close")!.addEventListener("click", close);
}
