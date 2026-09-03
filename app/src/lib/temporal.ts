import type { DbEngine, RowValue } from "./ipc";

/** Internal draft marker — rendered as NOW()/CURRENT_TIMESTAMP in SQL. */
export const SQL_NOW_SENTINEL = "__DBKONN_NOW__";

export type TemporalKind = "date" | "timestamp" | "time";

export function getTemporalKind(dataType: string): TemporalKind | null {
  const t = dataType.toLowerCase();
  if (/\bdate\b/.test(t) && !t.includes("time")) return "date";
  if (t.includes("timestamp") || t.includes("datetime")) return "timestamp";
  if (/\btime\b/.test(t)) return "time";
  return null;
}

export function isNowValue(val: RowValue): boolean {
  return val === SQL_NOW_SENTINEL;
}

export function sqlNowExpression(engine: DbEngine): string {
  switch (engine) {
    case "postgres":
      return "NOW()";
    case "mysql":
    case "sqlite":
      return "CURRENT_TIMESTAMP";
    case "mssql":
      return "GETDATE()";
  }
}

export function toDateInputValue(val: RowValue): string {
  if (val === null || val === undefined || isNowValue(val)) return "";
  const s = String(val);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : "";
}

export function toDateTimeLocalValue(val: RowValue): string {
  if (val === null || val === undefined || isNowValue(val)) return "";
  const s = String(val);

  // Extract the stored wall-clock fields verbatim. Parsing through
  // `new Date()` and reformatting in the viewer's local zone shifted the
  // displayed time (and, on save, the value written back) whenever the
  // viewer wasn't in UTC — corrupting every timestamptz edit.
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?/);
  if (m) {
    const seconds = m[3] ?? "00";
    return `${m[1]}T${m[2]}:${seconds}`;
  }

  return "";
}

/** The trailing timezone designator of a stored timestamp (`Z`, `+02:00`,
 *  `-05`, or `""` for a zoneless value), so an edited `timestamptz` can be
 *  written back in its original offset rather than the session default. */
export function extractTimezoneSuffix(val: RowValue): string {
  if (val === null || val === undefined || isNowValue(val)) return "";
  const s = String(val).trim();
  const m = s.match(/(Z|[+-]\d{2}(?::?\d{2})?)$/);
  return m ? m[1]! : "";
}

export function toTimeInputValue(val: RowValue): string {
  if (val === null || val === undefined || isNowValue(val)) return "";
  const s = String(val);
  const m = s.match(/(\d{2}:\d{2})(?::(\d{2}))?/);
  if (!m) return "";
  return m[2] ? `${m[1]}:${m[2]}` : `${m[1]}:00`;
}

export function fromDateTimeLocalValue(raw: string): string {
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?/);
  if (!m) return raw;
  return `${m[1]} ${m[2]}:${m[3] ?? "00"}`;
}
