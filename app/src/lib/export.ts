import { save } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import writeExcelFile from "write-excel-file/universal";

import type { ColumnInfo, DbEngine, RowValue } from "./ipc";
import { escapeHtml } from "./escape";
import { quoteIdent } from "./sqlQuote";

export type ExportFormat = "csv" | "tsv" | "xlsx" | "json" | "markdown" | "html" | "sql";

export const MAX_EXPORT_ROWS = 10_000;

export const formatMeta: Record<
  ExportFormat,
  { label: string; ext: string; dialogFilter: { name: string; extensions: string[] } }
> = {
  csv: { label: "CSV", ext: "csv", dialogFilter: { name: "CSV Files", extensions: ["csv"] } },
  tsv: { label: "TSV", ext: "tsv", dialogFilter: { name: "TSV Files", extensions: ["tsv"] } },
  xlsx: { label: "Excel (.xlsx)", ext: "xlsx", dialogFilter: { name: "Excel Workbook", extensions: ["xlsx"] } },
  json: { label: "JSON", ext: "json", dialogFilter: { name: "JSON Files", extensions: ["json"] } },
  markdown: { label: "Markdown", ext: "md", dialogFilter: { name: "Markdown Files", extensions: ["md"] } },
  html: { label: "HTML", ext: "html", dialogFilter: { name: "HTML Files", extensions: ["html"] } },
  sql: { label: "SQL INSERT", ext: "sql", dialogFilter: { name: "SQL Files", extensions: ["sql"] } },
};

function cellText(v: RowValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// Neutralise spreadsheet formula injection: a cell that a spreadsheet would
// evaluate as a formula (leading = + - @, or a leading tab/CR) gets a
// leading apostrophe so it's imported as literal text.
function guardFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function escapeDelimited(text: string, delimiter: string): string {
  const guarded = guardFormula(text);
  if (
    guarded.includes(delimiter) ||
    guarded.includes('"') ||
    guarded.includes("\n") ||
    guarded.includes("\r")
  ) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

function toDelimited(columns: ColumnInfo[], rows: RowValue[][], delimiter: string): string {
  const lines = [
    columns.map((c) => escapeDelimited(c.name, delimiter)).join(delimiter),
    ...rows.map((row) => row.map((v) => escapeDelimited(cellText(v), delimiter)).join(delimiter)),
  ];
  return lines.join("\n");
}

export function toCsv(columns: ColumnInfo[], rows: RowValue[][]): string {
  return toDelimited(columns, rows, ",");
}

export function toTsv(columns: ColumnInfo[], rows: RowValue[][]): string {
  return toDelimited(columns, rows, "\t");
}

export function toJson(columns: ColumnInfo[], rows: RowValue[][]): string {
  const objects = rows.map((row) =>
    Object.fromEntries(columns.map((c, i) => [c.name, row[i] ?? null])),
  );
  return JSON.stringify(objects, null, 2);
}

function escapeMarkdownCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function toMarkdown(columns: ColumnInfo[], rows: RowValue[][]): string {
  const header = `| ${columns.map((c) => escapeMarkdownCell(c.name)).join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    (row) => `| ${row.map((v) => escapeMarkdownCell(cellText(v))).join(" | ")} |`,
  );
  return [header, separator, ...body].join("\n");
}

export function toHtml(columns: ColumnInfo[], rows: RowValue[][], tableName: string): string {
  const thead = `<tr>${columns.map((c) => `<th>${escapeHtml(c.name)}</th>`).join("")}</tr>`;
  const tbody = rows
    .map((row) => `<tr>${row.map((v) => `<td>${escapeHtml(cellText(v))}</td>`).join("")}</tr>`)
    .join("\n");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(tableName)}</title>
<style>
table { border-collapse: collapse; font-family: sans-serif; font-size: 13px; }
th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; }
th { background: #f0f0f0; }
</style>
</head>
<body>
<table>
<thead>${thead}</thead>
<tbody>
${tbody}
</tbody>
</table>
</body>
</html>
`;
}

function sqlLiteral(v: RowValue, engine: DbEngine): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") {
    return engine === "postgres" ? (v ? "TRUE" : "FALSE") : v ? "1" : "0";
  }
  if (typeof v === "number") return String(v);
  const s = typeof v === "object" ? JSON.stringify(v) : v;
  // MySQL treats `\` as a string escape by default.
  const escaped =
    engine === "mysql"
      ? s.replace(/\\/g, "\\\\").replace(/'/g, "''")
      : s.replace(/'/g, "''");
  return `'${escaped}'`;
}

export function toSqlInsert(
  columns: ColumnInfo[],
  rows: RowValue[][],
  tableName: string,
  engine: DbEngine = "postgres",
): string {
  const columnList = columns.map((c) => quoteIdent(engine, c.name)).join(", ");
  const table = quoteIdent(engine, tableName);
  const statements = rows.map((row) => {
    const values = row.map((v) => sqlLiteral(v, engine)).join(", ");
    return `INSERT INTO ${table} (${columnList}) VALUES (${values});`;
  });
  return statements.join("\n");
}

export async function toXlsxBytes(columns: ColumnInfo[], rows: RowValue[][]): Promise<Uint8Array> {
  const sheetData = [
    columns.map((c) => c.name),
    ...rows.map((row) =>
      row.map((v) => (v === null || v === undefined || typeof v === "object" ? cellText(v) : v)),
    ),
  ];
  const blob = await writeExcelFile(sheetData).toBlob();
  return new Uint8Array(await blob.arrayBuffer());
}

export async function saveExport(
  format: ExportFormat,
  columns: ColumnInfo[],
  rows: RowValue[][],
  suggestedName: string,
  tableName: string,
  engine: DbEngine = "postgres",
): Promise<void> {
  const meta = formatMeta[format];
  const path = await save({
    defaultPath: suggestedName,
    filters: [meta.dialogFilter],
  });
  if (!path) return;

  if (format === "xlsx") {
    await writeFile(path, await toXlsxBytes(columns, rows));
    return;
  }

  let content: string;
  switch (format) {
    case "csv":
      content = toCsv(columns, rows);
      break;
    case "tsv":
      content = toTsv(columns, rows);
      break;
    case "json":
      content = toJson(columns, rows);
      break;
    case "markdown":
      content = toMarkdown(columns, rows);
      break;
    case "html":
      content = toHtml(columns, rows, tableName);
      break;
    case "sql":
      content = toSqlInsert(columns, rows, tableName, engine);
      break;
  }
  await writeTextFile(path, content);
}
