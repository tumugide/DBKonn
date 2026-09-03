import { ipc } from "../lib/ipc";
import { wireModalDismissal } from "../lib/modal";

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function showCreateDatabaseModal(
  connId: string,
  onCreated: (name: string) => void,
): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">New Database</div>
      <div class="modal-body">

        <div class="form-row">
          <label>Database Name</label>
          <input id="cdm-name" type="text" placeholder="my_new_db" style="width:100%" autofocus />
        </div>

        <div id="cdm-status" style="font-size:11px;min-height:16px;margin-top:4px;font-family:var(--font-mono);"></div>

      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cdm-cancel">Cancel</button>
        <button class="btn btn-primary" id="cdm-create">Create</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const nameInput = overlay.querySelector<HTMLInputElement>("#cdm-name")!;
  const createBtn = overlay.querySelector<HTMLButtonElement>("#cdm-create")!;
  const statusEl = overlay.querySelector<HTMLElement>("#cdm-status")!;

  nameInput.focus();

  function setStatus(msg: string, style: string) {
    statusEl.textContent = msg;
    statusEl.setAttribute(
      "style",
      `font-size:11px;min-height:16px;margin-top:4px;${style}`,
    );
  }

  async function create() {
    const name = nameInput.value.trim();
    if (!NAME_PATTERN.test(name) || name.length > 63) {
      setStatus(
        "Name must start with a letter or underscore and contain only letters, numbers, and underscores (max 63 chars)",
        "color:var(--accent-amber)",
      );
      return;
    }
    createBtn.disabled = true;
    setStatus("Creating…", "color:var(--text-muted)");
    try {
      await ipc.createDatabase(connId, name);
      overlay.remove();
      onCreated(name);
    } catch (e) {
      setStatus(`Error: ${e}`, "color:var(--accent-red)");
      createBtn.disabled = false;
    }
  }

  createBtn.addEventListener("click", () => void create());
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void create();
  });

  overlay
    .querySelector("#cdm-cancel")!
    .addEventListener("click", () => overlay.remove());
  wireModalDismissal(overlay, () => overlay.remove());
}
