use sqlparser::{
    dialect::{MsSqlDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect},
    parser::Parser,
};

use crate::{connection::DbEngine, error::CoreError};

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ParseError {
    pub message: String,
    pub line: Option<usize>,
    pub col: Option<usize>,
}

/// Validate SQL for the given engine dialect.
/// Returns Ok(()) if the SQL parses cleanly, or a ParseError if not.
pub fn validate_sql(sql: &str, engine: &DbEngine) -> Result<(), ParseError> {
    let result = match engine {
        DbEngine::Postgres => Parser::parse_sql(&PostgreSqlDialect {}, sql),
        DbEngine::MySQL => Parser::parse_sql(&MySqlDialect {}, sql),
        DbEngine::SQLite => Parser::parse_sql(&SQLiteDialect {}, sql),
        DbEngine::MSSQL => Parser::parse_sql(&MsSqlDialect {}, sql),
    };

    match result {
        Ok(_) => Ok(()),
        Err(e) => Err(ParseError {
            message: e.to_string(),
            line: None,
            col: None,
        }),
    }
}

/// Validate a user-supplied `WHERE` clause fragment before it is
/// interpolated into a generated `SELECT ... WHERE <clause>` (table
/// paging / filtering / row counts).
///
/// The clause is compiled on the frontend from structured filter rules,
/// but it crosses the IPC boundary as a raw string, so it is an
/// injection sink — most dangerously for SQL Server, whose `simple_query`
/// path executes stacked statements. This gate wraps the fragment in a
/// throwaway `SELECT` and parses it with the engine's dialect, rejecting
/// anything that isn't exactly one statement or that carries a statement
/// terminator.
pub fn validate_where_clause(clause: &str, engine: &DbEngine) -> Result<(), CoreError> {
    let trimmed = clause.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    // Wrap the fragment in a throwaway SELECT and parse it. sqlparser
    // splits on `;` at the statement level (respecting string literals),
    // so a stacked `... ; DROP TABLE x` fragment parses as two statements
    // and is rejected below, while a value literal containing `;` stays a
    // single statement and is allowed.
    let probe = format!("SELECT 1 FROM t WHERE {}", trimmed);
    let statements = match engine {
        DbEngine::Postgres => Parser::parse_sql(&PostgreSqlDialect {}, &probe),
        DbEngine::MySQL => Parser::parse_sql(&MySqlDialect {}, &probe),
        DbEngine::SQLite => Parser::parse_sql(&SQLiteDialect {}, &probe),
        DbEngine::MSSQL => Parser::parse_sql(&MsSqlDialect {}, &probe),
    }
    .map_err(|e| CoreError::Query(format!("Invalid filter clause: {}", e)))?;

    if statements.len() != 1 {
        return Err(CoreError::Query(
            "Filter clause must be a single boolean expression".to_string(),
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_plain_boolean_expression() {
        assert!(validate_where_clause("\"age\" > 21 AND \"name\" = 'x'", &DbEngine::Postgres).is_ok());
        assert!(validate_where_clause("", &DbEngine::Postgres).is_ok());
    }

    #[test]
    fn rejects_a_stacked_statement() {
        // The primary threat: a `;`-separated extra statement (RCE on the
        // SQL Server `simple_query` path). Parsed as >1 statement → rejected.
        assert!(validate_where_clause("1=1; DROP TABLE users", &DbEngine::MSSQL).is_err());
        assert!(validate_where_clause("1=1;DROP TABLE users;", &DbEngine::MSSQL).is_err());
        assert!(validate_where_clause("'x'='x'; TRUNCATE TABLE t", &DbEngine::Postgres).is_err());
    }

    #[test]
    fn allows_a_value_literal_containing_a_semicolon() {
        // A `;` inside a quoted value is not a statement separator.
        assert!(validate_where_clause("\"note\" = 'a;b'", &DbEngine::Postgres).is_ok());
    }

    #[test]
    fn rejects_syntactically_broken_fragments() {
        assert!(validate_where_clause("\"age\" > ", &DbEngine::Postgres).is_err());
        assert!(validate_where_clause("((\"a\" = 1)", &DbEngine::Postgres).is_err());
    }
}
