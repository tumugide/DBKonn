// ── Script splitting & statement-under-cursor ─────────────────────────────────
// Splits a multi-statement SQL script into individual statements while
// respecting string literals, quoted identifiers, and comments, so a `;` that
// appears inside a literal or comment never splits a statement.

export interface SqlStatement {
  sql: string;
  /** Character offset of the statement's first non-whitespace char. */
  start: number;
  /** Character offset just past the statement's final non-whitespace char. */
  end: number;
}

/**
 * Split a script into discrete statements. A statement boundary is a
 * semicolon that occurs outside of any string literal, quoted identifier,
 * line comment, or block comment. Trailing semicolons are not included in the
 * returned statement text.
 */
export function splitStatements(source: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  const n = source.length;
  let i = 0;
  let quote: string | null = null; // ', ", or `
  let isLineComment = false;
  let inBlockComment = false;
  let runStart = 0; // start of the current segment (untrimmed)
  let stmtStart = -1; // trimmed start of current statement

  const flush = (rawEnd: number) => {
    const text = source.slice(stmtStart < 0 ? runStart : stmtStart, rawEnd).trimEnd();
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      const body = trimmed.endsWith(";") ? trimmed.slice(0, -1).trimEnd() : trimmed;
      const bodyTrimmed = body.trim();
      const relStart = text.indexOf(bodyTrimmed);
      const absStart = (stmtStart < 0 ? runStart : stmtStart) + relStart;
      statements.push({
        sql: bodyTrimmed,
        start: absStart,
        end: absStart + bodyTrimmed.length,
      });
    }
    stmtStart = -1;
  };

  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (stmtStart < 0 && !isLineComment && !inBlockComment && quote === null && !/\s/.test(ch)) {
      stmtStart = i;
    }

    if (quote !== null) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) {
        if (next === quote) {
          i += 2;
          continue;
        }
        quote = null;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (isLineComment) {
      if (ch === "\n") {
        isLineComment = false;
        // Only a *leading* comment (before any statement text) advances the
        // segment start. A comment in the middle of a statement — e.g.
        // `SELECT 1 -- note\n, 2;` — must leave the statement bounds intact.
        if (stmtStart < 0) {
          runStart = i + 1;
        }
      }
      i += 1;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === "-" && next === "-") {
      isLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "#") {
      // MySQL-style `#` comments only — and only when `#` starts a line, so a
      // Postgres bitwise/JSON operator (`#`, `#>`, `#>>`, `#-`) mid-statement
      // isn't mistaken for a comment and used to swallow the rest of the line.
      let j = i - 1;
      while (j >= 0 && source[j] !== "\n" && /\s/.test(source[j]!)) j -= 1;
      if (j < 0 || source[j] === "\n") {
        isLineComment = true;
        i += 1;
        continue;
      }
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === ";") {
      flush(i);
      i += 1;
      runStart = i;
      continue;
    }
    i += 1;
  }

  if (stmtStart >= 0) {
    flush(n);
  }

  return statements;
}

/**
 * The index of the statement containing `offset` (a character offset into the
 * full script), or `-1` when offset lands outside any statement (e.g. leading
 * whitespace).
 */
export function statementIndexAt(source: string, offset: number): number {
  const stmts = splitStatements(source);
  for (let i = 0; i < stmts.length; i++) {
    const { start, end } = stmts[i]!;
    // `end` is just past the last char; allow a caret sitting exactly there
    // (the common "cursor at end of the statement I just typed" case) to still
    // resolve to that statement.
    if (offset >= start && offset <= end) return i;
  }
  return -1;
}
