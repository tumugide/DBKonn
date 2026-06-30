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

function formatSqlValue(engine: DbEngine, val: RowValue): string {
  if (val === SQL_NOW_SENTINEL) return sqlNowExpression(engine);
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "boolean") {
    if (engine === "postgres") return val ? "TRUE" : "FALSE";
    return val ? "1" : "0";
  }
  if (typeof val === "number") return String(val);
  if (typeof val === "string") {
    if (val.startsWith("0x")) return val;
    return quoteValue(val);
  }
  if (typeof val === "object") {
    return quoteValue(JSON.stringify(val));
  }
  return quoteValue(String(val));
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
