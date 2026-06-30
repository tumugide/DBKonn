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

export function quoteValue(val: string): string {
  return `'${val.replace(/'/g, "''")}'`;
}
