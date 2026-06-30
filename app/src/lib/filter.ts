// ── Filter builder → WHERE clause compiler ────────────────────────────────────

export type FilterOperator =
  | "=" | "!=" | "<" | "<=" | ">" | ">="
  | "LIKE" | "NOT LIKE" | "IS NULL" | "IS NOT NULL"
  | "IN" | "NOT IN";

export interface FilterRule {
  id: string;
  column: string;
  operator: FilterOperator;
  value: string;
  conjunction: "AND" | "OR";  // how this rule joins with the NEXT one
}

const NULLARY_OPS: FilterOperator[] = ["IS NULL", "IS NOT NULL"];
const LIST_OPS:    FilterOperator[] = ["IN", "NOT IN"];

function quoteIdent(name: string): string {
  // Basic identifier quoting — works for PG, SQLite, MSSQL
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteValue(val: string): string {
  return `'${val.replace(/'/g, "''")}'`;
}

export function compileWhereClause(rules: FilterRule[]): string {
  if (rules.length === 0) return "";

  const parts: string[] = [];

  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    const col = quoteIdent(r.column);
    let expr = "";

    if (NULLARY_OPS.includes(r.operator)) {
      expr = `${col} ${r.operator}`;
    } else if (LIST_OPS.includes(r.operator)) {
      const list = r.value
        .split(",")
        .map(v => quoteValue(v.trim()))
        .join(", ");
      expr = `${col} ${r.operator} (${list})`;
    } else {
      // Try to detect numeric values to avoid quoting
      const isNum = /^-?\d+(\.\d+)?$/.test(r.value.trim());
      const val   = isNum ? r.value.trim() : quoteValue(r.value);
      expr = `${col} ${r.operator} ${val}`;
    }

    parts.push(expr);

    // Append conjunction before the next rule
    if (i < rules.length - 1) {
      parts.push(r.conjunction);
    }
  }

  return parts.join(" ");
}

export function newRule(column: string): FilterRule {
  return {
    id: Math.random().toString(36).slice(2),
    column,
    operator: "=",
    value: "",
    conjunction: "AND",
  };
}

export const OPERATORS: FilterOperator[] = [
  "=", "!=", "<", "<=", ">", ">=",
  "LIKE", "NOT LIKE", "IS NULL", "IS NOT NULL", "IN", "NOT IN",
];
