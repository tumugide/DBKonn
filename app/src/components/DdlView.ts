import { wireModalDismissal } from "../lib/modal";
import { escapeHtml as esc } from "../lib/escape";

/**
 * Show an object's CREATE definition in a read-only modal. The DDL is
 * rendered via `textContent`-safe escaping (`esc`), never innerHTML with raw
 * SQL — a definition containing markup/scripts must not become DOM.
 */
export function showDdlModal(objectLabel: string, ddl: string): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal modal-wide" aria-label="DDL of ${esc(objectLabel)}">
      <div class="modal-title">DDL — ${esc(objectLabel)}</div>
      <div class="modal-body ddl-body">
        <pre class="ddl-view">${esc(ddl)}</pre>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="ddl-close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  wireModalDismissal(overlay, close);
  overlay.querySelector("#ddl-close")!.addEventListener("click", close);
}