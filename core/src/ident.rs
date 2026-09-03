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
}
