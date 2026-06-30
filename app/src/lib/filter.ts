// ── Filter builder → WHERE clause compiler ────────────────────────────────────

import type { DbEngine } from "./ipc";
import { quoteIdent, quoteValue } from "./sqlQuote";

export type FilterOperator =
  | "="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "LIKE"
  | "NOT LIKE"
  | "IS NULL"
  | "IS NOT NULL"
  | "IN"
  | "NOT IN";

export interface FilterRule {
  id: string;
  column: string;
  operator: FilterOperator;
  value: string;
  conjunction: "AND" | "OR"; // how this rule joins with the NEXT one
}

const NULLARY_OPS: FilterOperator[] = ["IS NULL", "IS NOT NULL"];
const LIST_OPS: FilterOperator[] = ["IN", "NOT IN"];
const STRING_OPS: FilterOperator[] = [
  "=",
  "!=",
  "LIKE",
  "NOT LIKE",
  "IN",
  "NOT IN",
];
const NUMERIC_COMPARE_OPS: FilterOperator[] = ["<", "<=", ">", ">="];

function isNumericDataType(dataType: string | undefined): boolean {
  if (!dataType) return false;
  const t = dataType.toLowerCase();
  return /\b(int|integer|bigint|smallint|tinyint|mediumint|serial|bigserial|smallserial|float|double|real|numeric|decimal|number|money|bit)\b/.test(
    t,
  );
}

function isTextDataType(dataType: string | undefined): boolean {
  if (!dataType) return false;
  const t = dataType.toLowerCase();
  return (
    /\b(char|varchar|character|text|string|enum|uuid|json|jsonb|xml|citext|name|bpchar)\b/.test(
      t,
    ) || t.includes("enum(")
  );
}

function isNumericLiteral(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

function formatFilterValue(
  operator: FilterOperator,
  value: string,
  dataType?: string,
): string {
  const trimmed = value.trim();

  if (STRING_OPS.includes(operator)) {
    return quoteValue(trimmed);
  }

  if (
    NUMERIC_COMPARE_OPS.includes(operator) &&
    isNumericDataType(dataType) &&
    isNumericLiteral(trimmed)
  ) {
    return trimmed;
  }

  // Text / unknown columns: always quote so varchar values like "0123" work.
  if (isTextDataType(dataType) || !isNumericDataType(dataType)) {
    return quoteValue(trimmed);
  }

  return isNumericLiteral(trimmed) ? trimmed : quoteValue(trimmed);
}

export function compileWhereClause(
  rules: FilterRule[],
  engine: DbEngine,
  columnTypes?: Map<string, string>,
): string {
  if (rules.length === 0) return "";

  const built: { expr: string; afterConj: "AND" | "OR" }[] = [];

  for (const r of rules) {
    const col = quoteIdent(engine, r.column);
    const dataType = columnTypes?.get(r.column);
    let expr = "";

    if (NULLARY_OPS.includes(r.operator)) {
      expr = `${col} ${r.operator}`;
    } else if (LIST_OPS.includes(r.operator)) {
      const items = r.value
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
      if (items.length === 0) continue;
      const list = items
        .map((v) => formatFilterValue("=", v, dataType))
        .join(", ");
      expr = `${col} ${r.operator} (${list})`;
    } else {
      if (!r.value.trim()) continue;
      const val = formatFilterValue(r.operator, r.value, dataType);
      expr = `${col} ${r.operator} ${val}`;
    }

    built.push({ expr, afterConj: r.conjunction });
  }

  return built
    .map((b, i) =>
      i < built.length - 1 ? `${b.expr} ${b.afterConj}` : b.expr,
    )
    .join(" ");
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
  "=",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "LIKE",
  "NOT LIKE",
  "IS NULL",
  "IS NOT NULL",
  "IN",
  "NOT IN",
];
