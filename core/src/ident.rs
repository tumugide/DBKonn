//! Dialect-correct SQL quoting.
//!
//! DBKonn builds a lot of SQL by string interpolation (schema browsing,
//! table paging, sorting, the row editor). Identifiers and literals that
//! flow into those strings originate in the webview and can contain the
//! very characters that delimit them. Every such interpolation MUST go
//! through [`quote_ident`] / [`quote_literal`] so a table called
//! `foo"; DROP TABLE bar; --` (or a cell value with a stray backslash on
//! MySQL) cannot break out of its quoting.

use crate::connection::DbEngine;
use crate::query::RowValue;

/// Quote an identifier (schema / table / column / index name) for `engine`,
/// escaping the closing-quote character by doubling it.
///
/// * Postgres / SQLite → `"name"` (`"` doubled)
/// * MySQL / MariaDB    → `` `name` `` (`` ` `` doubled)
/// * SQL Server         → `[name]` (`]` doubled)
pub fn quote_ident(engine: &DbEngine, name: &str) -> String {
    match engine {
        DbEngine::MySQL => format!("`{}`", name.replace('`', "``")),
        DbEngine::MSSQL => format!("[{}]", name.replace(']', "]]")),
        DbEngine::Postgres | DbEngine::SQLite => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// Quote a string value as a SQL literal for `engine`.
///
/// Every dialect doubles `'`. MySQL/MariaDB additionally treat `\` as an
/// escape character inside string literals unless `NO_BACKSLASH_ESCAPES`
/// is set (it is off by default), so a trailing `\` or an embedded `\'`
/// would otherwise escape the closing quote — the backslash is doubled
/// first for that engine.
pub fn quote_literal(engine: &DbEngine, value: &str) -> String {
    match engine {
        DbEngine::MySQL => {
            let escaped = value.replace('\\', "\\\\").replace('\'', "''");
            format!("'{}'", escaped)
        }
        _ => format!("'{}'", value.replace('\'', "''")),
    }
}

/// Render a `RowValue` as the bound in a keyset comparison
/// (`WHERE col > <bound>`), i.e. the value of the ordering column on the last
/// row of the previous page. Numerics and booleans map to bare literals;
/// everything else goes through [`quote_literal`]. The keyset column itself is
/// interpolated with [`quote_ident`] by callers — these two together keep the
/// keyset path injection-safe (see CLAUDE.md guardrail #1).
///
/// `NULL` deliberately renders as `NULL` (comparisons are then always false,
/// so a NULL keyset bound simply returns an empty page) — the UI only ever
/// chooses a keyset column with no NULLs (a single-column PK or unique index).
pub fn render_keyset_value(engine: &DbEngine, value: &RowValue) -> String {
    match value {
        RowValue::Null => "NULL".to_string(),
        RowValue::Bool(b) => {
            if *b {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        RowValue::Integer(i) => i.to_string(),
        RowValue::Float(f) => f.to_string(),
        RowValue::Text(s) => quote_literal(engine, s),
        RowValue::Json(j) => quote_literal(engine, &j.to_string()),
        RowValue::Binary(s) => format!("X'{}'", s),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_identifiers_per_dialect() {
        assert_eq!(quote_ident(&DbEngine::Postgres, "users"), "\"users\"");
        assert_eq!(quote_ident(&DbEngine::SQLite, "users"), "\"users\"");
        assert_eq!(quote_ident(&DbEngine::MySQL, "users"), "`users`");
        assert_eq!(quote_ident(&DbEngine::MSSQL, "users"), "[users]");
    }

    #[test]
    fn escapes_closing_quote_in_identifiers() {
        // pg/sqlite: embedded double-quote
        assert_eq!(
            quote_ident(&DbEngine::Postgres, "we\"ird"),
            "\"we\"\"ird\""
        );
        // A classic break-out attempt is neutralised.
        assert_eq!(
            quote_ident(&DbEngine::Postgres, "x\"; DROP TABLE y; --"),
            "\"x\"\"; DROP TABLE y; --\""
        );
        // mysql: embedded backtick
        assert_eq!(quote_ident(&DbEngine::MySQL, "we`ird"), "`we``ird`");
        // mssql: embedded closing bracket
        assert_eq!(quote_ident(&DbEngine::MSSQL, "we]ird"), "[we]]ird]");
    }

    #[test]
    fn quotes_literals_and_doubles_single_quote() {
        assert_eq!(quote_literal(&DbEngine::Postgres, "it's"), "'it''s'");
        assert_eq!(quote_literal(&DbEngine::MSSQL, "it's"), "'it''s'");
        assert_eq!(quote_literal(&DbEngine::SQLite, "it's"), "'it''s'");
    }

    #[test]
    fn mysql_literal_escapes_backslash() {
        // Trailing backslash would otherwise escape the closing quote.
        assert_eq!(quote_literal(&DbEngine::MySQL, "ends\\"), "'ends\\\\'");
        // `\' ... ` break-out attempt.
        assert_eq!(
            quote_literal(&DbEngine::MySQL, "a\\' OR 1=1 -- "),
            "'a\\\\'' OR 1=1 -- '"
        );
    }

    #[test]
    fn non_mysql_literal_leaves_backslash_alone() {
        // standard_conforming_strings: backslash is literal in pg/sqlite/mssql.
        assert_eq!(quote_literal(&DbEngine::Postgres, "a\\b"), "'a\\b'");
    }

    #[test]
    fn keyset_value_renders_numerics_bare() {
        assert_eq!(
            render_keyset_value(&DbEngine::Postgres, &RowValue::Integer(42)),
            "42"
        );
        assert_eq!(
            render_keyset_value(&DbEngine::MySQL, &RowValue::Float(3.5)),
            "3.5"
        );
        assert_eq!(
            render_keyset_value(&DbEngine::Postgres, &RowValue::Bool(true)),
            "TRUE"
        );
        assert_eq!(
            render_keyset_value(&DbEngine::Postgres, &RowValue::Null),
            "NULL"
        );
    }

    #[test]
    fn keyset_value_quotes_text_per_dialect() {
        assert_eq!(
            render_keyset_value(&DbEngine::Postgres, &RowValue::Text("it's".into())),
            "'it''s'"
        );
        // MySQL backslash escaping applies in keyset bounds too.
        assert_eq!(
            render_keyset_value(&DbEngine::MySQL, &RowValue::Text("a\\' OR 1=1 -- ".into())),
            "'a\\\\'' OR 1=1 -- '"
        );
        // JSON bound is serialized then quoted — no injection vector.
        let j = serde_json::json!({"x": "'; DROP TABLE a;--"});
        assert_eq!(
            render_keyset_value(&DbEngine::Postgres, &RowValue::Json(j)),
            "'{\"x\":\"''; DROP TABLE a;--\"}'"
        );
    }
}
