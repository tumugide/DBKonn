import type { ColumnInfo, DbEngine, RowValue } from "./ipc";
import { quoteIdent, quoteValue } from "./sqlQuote";
import {
  sqlNowExpression,
  SQL_NOW_SENTINEL,
} from "./temporal";

function qualifyTable(
  engine: DbEngine,
  schema: string | undefined,
  table: string,
  database?: string,
): string {
  switch (engine) {
    case "mysql": {
      const db = schema ?? database ?? "";
      return `${quoteIdent(engine, db)}.${quoteIdent(engine, table)}`;
    }
    case "mssql":
      return `${quoteIdent(engine, schema ?? "dbo")}.${quoteIdent(engine, table)}`;
    case "sqlite":
      return quoteIdent(engine, table);
    default:
      return `${quoteIdent(engine, schema ?? "public")}.${quoteIdent(engine, table)}`;
  }
}

/** Render a JS array as a Postgres array literal (`'{a,b,c}'`). */
function pgArrayLiteral(arr: unknown[]): string {
  const elems = arr.map((el) => {
    if (el === null || el === undefined) return "NULL";
    if (typeof el === "number" || typeof el === "boolean") return String(el);
    // Quote every string element and escape `"` / `\` inside it — an
    // unquoted element containing a comma or brace would corrupt the literal.
    const s = String(el).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${s}"`;
  });
  return `'{${elems.join(",")}}'`;
}

function formatSqlValue(engine: DbEngine, val: RowValue): string {
  if (val === SQL_NOW_SENTINEL) return sqlNowExpression(engine);
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "boolean") {
    if (engine === "postgres") return val ? "TRUE" : "FALSE";
    return val ? "1" : "0";
  }
  if (typeof val === "number") return String(val);
  if (typeof val === "string") {
    // Always quote. A previous `0x…` fast-path emitted the value into SQL
    // unquoted, which is an injection sink for any text column holding a
    // value that happens to start with "0x". Binary/BLOB columns can't be
    // round-tripped through the driver's truncated hex preview anyway;
    // proper binary editing is tracked separately.
    return quoteValue(engine, val);
  }
  if (Array.isArray(val)) {
    // A pg array column round-trips as a JSON array; writing it back as
    // `'["a","b"]'` (JSON text) is a type error / wrong value. Emit a real
    // pg array literal instead. Other engines have no array type — fall back
    // to JSON text.
    return engine === "postgres"
      ? pgArrayLiteral(val)
      : quoteValue(engine, JSON.stringify(val));
  }
  if (typeof val === "object") {
    return quoteValue(engine, JSON.stringify(val));
  }
  return quoteValue(engine, String(val));
}

/** True for column types that can meaningfully hold an empty string. Used to
 *  stop an un-nulled numeric/date/json field from being written as `''`. */
export function isTextLikeType(dataType: string | undefined): boolean {
  if (!dataType) return true; // unknown → treat as text, the safe default
  const t = dataType.toLowerCase();
  if (/\b(char|varchar|character|text|string|clob|citext|name|bpchar|xml|enum|uuid)\b/.test(t)) {
    return true;
  }
  return /(int|serial|numeric|decimal|real|double|float|money|bool|bit|date|time|timestamp|json|bytea|blob|binary|array)/.test(
    t,
  )
    ? false
    : true;
}

function valuesEqual(a: RowValue, b: RowValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

export function cloneRowValue(val: RowValue): RowValue {
  if (val === null || val === undefined) return null;
  if (typeof val === "object") return JSON.parse(JSON.stringify(val));
  return val;
}

export function parseFieldInput(
  raw: string,
  isNull: boolean,
  original: RowValue,
): RowValue {
  if (isNull) return null;
  if (typeof original === "boolean") {
    const lower = raw.trim().toLowerCase();
    if (lower === "true" || lower === "1") return true;
    if (lower === "false" || lower === "0") return false;
    return original;
  }
  if (typeof original === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : original;
  }
  if (typeof original === "object" && original !== null) {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return original;
    }
  }
  return raw;
}

export function buildUpdateSql(options: {
  engine: DbEngine;
  schema?: string;
  database?: string;
  table: string;
  columns: ColumnInfo[];
  original: RowValue[];
  draft: RowValue[];
}): { sql: string } | { error: string } {
  const { engine, schema, database, table, columns, original, draft } = options;

  const changed: { col: ColumnInfo; idx: number; val: RowValue }[] = [];
  columns.forEach((col, idx) => {
    if (!valuesEqual(original[idx] ?? null, draft[idx] ?? null)) {
      changed.push({ col, idx, val: draft[idx] ?? null });
    }
  });

  if (changed.length === 0) {
    return { error: "No changes to commit" };
  }

  const pkCols = columns.filter((c) => c.is_primary_key);
  const whereCols = pkCols.length > 0 ? pkCols : columns;

  const whereParts = whereCols.map((col) => {
    const idx = columns.findIndex((c) => c.name === col.name);
    const val = original[idx] ?? null;
    if (val === null) {
      return `${quoteIdent(engine, col.name)} IS NULL`;
    }
    return `${quoteIdent(engine, col.name)} = ${formatSqlValue(engine, val)}`;
  });

  const setParts = changed.map(
    ({ col, val }) =>
      `${quoteIdent(engine, col.name)} = ${formatSqlValue(engine, val)}`,
  );

  const sql = `UPDATE ${qualifyTable(engine, schema, table, database)} SET ${setParts.join(", ")} WHERE ${whereParts.join(" AND ")}`;
  return { sql };
}

export function buildDeleteSql(options: {
  engine: DbEngine;
  schema?: string;
  database?: string;
  table: string;
  columns: ColumnInfo[];
  rows: RowValue[][];
}): { sql: string } | { error: string } {
  const { engine, schema, database, table, columns, rows } = options;

  if (rows.length === 0) {
    return { error: "No rows selected" };
  }

  const pkCols = columns.filter((c) => c.is_primary_key);
  const whereCols = pkCols.length > 0 ? pkCols : columns;

  const rowConditions = rows.map((row) => {
    const parts = whereCols.map((col) => {
      const idx = columns.findIndex((c) => c.name === col.name);
      const val = row[idx] ?? null;
      if (val === null) {
        return `${quoteIdent(engine, col.name)} IS NULL`;
      }
      return `${quoteIdent(engine, col.name)} = ${formatSqlValue(engine, val)}`;
    });
    return `(${parts.join(" AND ")})`;
  });

  const sql = `DELETE FROM ${qualifyTable(engine, schema, table, database)} WHERE ${rowConditions.join(" OR ")}`;
  return { sql };
}
