// ── Query history ─────────────────────────────────────────────────────────────
// Auto-logs every executed statement to `localStorage` (durable across
// restarts), so a user can search and re-run past queries. Deliberately
// lightweight: a flat list of { sql, conn, ts, ok }, newest first.

export interface QueryHistoryEntry {
  id: string;
  /** Connection id the statement ran against. */
  connKey: string;
  /** Human-readable connection name for display. */
  connName: string;
  sql: string;
  /** true if the statement completed without a DB error. */
  ok: boolean;
  /** Epoch ms when the statement finished. */
  ts: number;
}

const HISTORY_KEY = "dbkonn-query-history";
const MAX_ENTRIES = 500;

function loadAll(): QueryHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as QueryHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function saveAll(entries: QueryHistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    /* storage unavailable or full — history is best-effort */
  }
}

/** Record one executed statement. Entries are deduped against the most recent
 *  identical statement on the same connection so rapid re-runs of the same
 *  query don't spam the history. */
export function addHistory(
  entry: Omit<QueryHistoryEntry, "id" | "ts">,
): void {
  const entries = loadAll();
  const now = Date.now();
  const full: QueryHistoryEntry = { ...entry, id: `${now}-${Math.random().toString(36).slice(2, 8)}`, ts: now };
  // Drop the previous identical statement (same conn + sql), then prepend.
  const filtered = entries.filter(
    (e) => !(e.connKey === entry.connKey && e.sql === entry.sql),
  );
  filtered.unshift(full);
  saveAll(filtered);
}

/** All history, newest first. Optional filters narrow results. */
export function getHistory(filter?: {
  connKey?: string;
  text?: string;
  limit?: number;
}): QueryHistoryEntry[] {
  let entries = loadAll();
  if (filter?.connKey) {
    entries = entries.filter((e) => e.connKey === filter.connKey);
  }
  if (filter?.text) {
    const q = filter.text.trim().toLowerCase();
    entries = entries.filter((e) => e.sql.toLowerCase().includes(q));
  }
  if (filter?.limit && filter.limit > 0) {
    entries = entries.slice(0, filter.limit);
  }
  return entries;
}

export function removeHistory(id: string): void {
  saveAll(loadAll().filter((e) => e.id !== id));
}

export function clearHistory(): void {
  saveAll([]);
}

/** A short one-line label for an entry (first non-whitespace line, truncated). */
export function historyLabel(sql: string): string {
  const line = sql
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? sql).slice(0, 120);
}
