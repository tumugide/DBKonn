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

  if (s.includes("T")) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return formatLocalDateTime(d);
  }

  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?/);
  if (m) {
    const seconds = m[3] ?? "00";
    return `${m[1]}T${m[2]}:${seconds}`;
  }

  return "";
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

function formatLocalDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
