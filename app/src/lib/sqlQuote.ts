import type { DbEngine } from "./ipc";

export function quoteIdent(engine: DbEngine, name: string): string {
  switch (engine) {
    case "mysql":
      return `\`${name.replace(/`/g, "``")}\``;
    case "mssql":
      return `[${name.replace(/]/g, "]]")}]`;
    default:
      return `"${name.replace(/"/g, '""')}"`;
  }
}

// Quote a string value as a SQL literal. Every dialect doubles `'`.
// MySQL/MariaDB additionally treat `\` as an escape character inside string
// literals unless NO_BACKSLASH_ESCAPES is set (off by default), so a
// trailing `\` or an embedded `\'` would otherwise escape the closing
// quote — double the backslash first for that engine.
export function quoteValue(engine: DbEngine, val: string): string {
  if (engine === "mysql") {
    return `'${val.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  }
  return `'${val.replace(/'/g, "''")}'`;
}
