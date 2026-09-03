// Single HTML-escaping helper. Several components each had their own `esc()`
// that diverged (some skipped `>` , none escaped `'`), which matters when the
// value lands inside a single-quoted attribute.
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}
