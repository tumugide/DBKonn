// Shared modal behaviour: Escape-to-close, backdrop click, focus trap, and
// autofocus. The app's modals are hand-built `<div class="modal-overlay">`
// nodes appended to <body>; this wires the keyboard/focus handling they were
// all missing.

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Attach standard dismissal + focus behaviour to a modal overlay.
 *
 * @param overlay the `.modal-overlay` element (its first `.modal` child is the dialog)
 * @param close   called to tear the modal down (typically `() => overlay.remove()`)
 * @returns a cleanup function (also runs automatically when `close` is invoked via Escape/backdrop)
 */
export function wireModalDismissal(
  overlay: HTMLElement,
  close: () => void,
): () => void {
  const dialog =
    overlay.querySelector<HTMLElement>(".modal") ?? overlay;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const prevFocus = document.activeElement as HTMLElement | null;
  let done = false;

  const cleanup = () => {
    if (done) return;
    done = true;
    document.removeEventListener("keydown", onKey, true);
    prevFocus?.focus?.();
  };

  const closeAndCleanup = () => {
    cleanup();
    close();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      closeAndCleanup();
      return;
    }
    if (e.key === "Tab") {
      const items = focusables(dialog);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !dialog.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeAndCleanup();
  });

  // Autofocus: honour an explicit [autofocus], else the first focusable.
  queueMicrotask(() => {
    const marked = dialog.querySelector<HTMLElement>("[autofocus]");
    (marked ?? focusables(dialog)[0] ?? dialog).focus?.();
  });

  return cleanup;
}
