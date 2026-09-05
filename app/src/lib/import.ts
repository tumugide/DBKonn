// ── Import: CSV → table, `.sql` file → editor ────────────────────────────────
// Frontend file-picking + parsing; inserts are sent to the backend as batched
// `INSERT ... VALUES` statements run through the standard `execute_query` path
// (so they respect the active transaction and the injection-safe quoters).

import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import type { DbEngine } from "./ipc";
import { quoteIdent, quoteValue } from "./sqlQuote";

/** Open a `.sql` file and return its text (null when the user cancels). */
export async function openSqlFile(): Promise<{ path: string; text: string } | null> {
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "SQL Files", extensions: ["sql"] }],
  });
  if (!path || Array.isArray(path)) return null;
  const text = await readTextFile(path);
  return { path, text };
}

/** Open a `.csv` file and return its path + text (null when the user cancels). */
export async function openCsvFile(): Promise<{
  path: string;
  name: string;
  text: string;
} | null> {
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "CSV Files", extensions: ["csv"] }],
  });
  if (!path || Array.isArray(path)) return null;
  const text = await readTextFile(path);
  const name = path.split("/").pop() ?? path;
  return { path, name, text };
}

/**
 * A small CSV parser that handles quoted fields, `""` escapes, embedded
 * newlines (inside quotes), and trailing/empty lines. Returns the header row
 * plus the data rows, each as string arrays.
 */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        field += c;
      }
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (c === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    if (c === "\r") {
      if (text[i + 1] === "\n") i += 1;
      pushRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  // Flush a final partial field/row (no trailing newline).
  if (field.length > 0 || row.length > 0) pushRow();

  // Drop fully-empty rows (e.g. trailing newline artifacts).
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const headers = nonEmpty[0]!.map((h) => h.trim());
  const data = nonEmpty.slice(1).map((r) =>
    r.length < headers.length ? [...r, ...Array(headers.length - r.length).fill("")] : r,
  );
  return { headers, rows: data };
}

function valueLiteral(val: string, engine: DbEngine): string {
  if (val === "") return "NULL";
  return quoteValue(engine, val);
}

/**
 * Build one multi-row INSERT covering up to `batchSize` rows. `columns` are
 * the target-table column names (matched by header). All strings are quoted
 * with the dialect-aware quoter.
 */
export function buildInsertStatements(
  engine: DbEngine,
  table: string,
  columns: string[],
  dataRows: string[][],
  batchSize = 100,
  headerIndex: number[] = [],
): string[] {
  const colList = columns.map((c) => quoteIdent(engine, c)).join(", ");
  const t = quoteIdent(engine, table);
  const withHeader = headerIndex.length === 0 ? undefined : headerIndex;
  const statements: string[] = [];

  for (let start = 0; start < dataRows.length; start += batchSize) {
    const batch = dataRows.slice(start, start + batchSize);
    const valueGroups = batch.map((row) => {
      const vals = withHeader
        ? withHeader.map((ci) => valueLiteral(row[ci] ?? "", engine))
        : row.map((v) => valueLiteral(v, engine));
      return `(${vals.join(", ")})`;
    });
    statements.push(`INSERT INTO ${t} (${colList}) VALUES\n${valueGroups.join(",\n")};`);
  }
  return statements;
}
