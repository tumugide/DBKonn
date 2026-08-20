export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
}

let activeMenu: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

export function closeContextMenu(): void {
  activeMenu?.remove();
  activeMenu = null;
  cleanup?.();
  cleanup = null;
}

// Shows a right-click menu at the given viewport coordinates. Only one
// context menu can be open at a time — opening a new one closes any other.
export function showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
  closeContextMenu();

  const menu = document.createElement("div");
  menu.className = "context-menu";

  items.forEach((item) => {
    if (item.separatorBefore) {
      const sep = document.createElement("div");
      sep.className = "context-menu-separator";
      menu.appendChild(sep);
    }
    const btn = document.createElement("button");
    btn.className = `context-menu-item${item.danger ? " danger" : ""}`;
    btn.textContent = item.label;
    btn.disabled = !!item.disabled;
    btn.onclick = () => {
      closeContextMenu();
      item.onSelect();
    };
    menu.appendChild(btn);
  });

  // Render off-screen first so we can measure it, then clamp into the viewport.
  menu.style.left = "0px";
  menu.style.top = "0px";
  menu.style.visibility = "hidden";
  document.body.appendChild(menu);

  const { offsetWidth: w, offsetHeight: h } = menu;
  const left = Math.min(x, window.innerWidth - w - 4);
  const top = Math.min(y, window.innerHeight - h - 4);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, top)}px`;
  menu.style.visibility = "visible";

  activeMenu = menu;

  const onOutsideClick = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) closeContextMenu();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeContextMenu();
  };
  const onScroll = () => closeContextMenu();

  document.addEventListener("mousedown", onOutsideClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("blur", closeContextMenu);

  cleanup = () => {
    document.removeEventListener("mousedown", onOutsideClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("blur", closeContextMenu);
  };
}
