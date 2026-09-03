import { formatMeta, type ExportFormat } from "../lib/export";

export interface ExportButtonOptions {
  formats: ExportFormat[];
  onSelect: (format: ExportFormat) => void;
}

export interface ExportButton {
  element: HTMLElement;
  setDisabled: (disabled: boolean) => void;
}

export function createExportButton(opts: ExportButtonOptions): ExportButton {
  const wrapper = document.createElement("div");
  wrapper.className = "export-menu-wrapper";

  const button = document.createElement("button");
  button.className = "btn btn-secondary";
  button.textContent = "Export ▾";
  wrapper.appendChild(button);

  let menu: HTMLElement | null = null;

  function closeMenu() {
    menu?.remove();
    menu = null;
    document.removeEventListener("mousedown", onOutsideClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
  }

  function onOutsideClick(e: MouseEvent) {
    if (menu && !wrapper.contains(e.target as Node)) closeMenu();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") closeMenu();
  }

  function openMenu() {
    if (menu) {
      closeMenu();
      return;
    }
    menu = document.createElement("div");
    menu.className = "export-menu";
    for (const format of opts.formats) {
      const item = document.createElement("button");
      item.className = "export-menu-item";
      item.textContent = formatMeta[format].label;
      item.onclick = () => {
        closeMenu();
        opts.onSelect(format);
      };
      menu.appendChild(item);
    }
    wrapper.appendChild(menu);

    // Keep the dropdown inside the viewport (it's absolutely positioned to
    // the wrapper, which can sit near the right/bottom edge of a toolbar).
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth - 4) {
      menu.style.left = "auto";
      menu.style.right = "0";
    }
    if (r.bottom > window.innerHeight - 4) {
      menu.style.top = "auto";
      menu.style.bottom = "100%";
    }

    document.addEventListener("mousedown", onOutsideClick, true);
    document.addEventListener("keydown", onKeyDown, true);
  }

  button.onclick = () => openMenu();

  return {
    element: wrapper,
    setDisabled(disabled: boolean) {
      button.disabled = disabled;
      if (disabled) closeMenu();
    },
  };
}
