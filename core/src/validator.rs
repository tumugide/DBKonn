use sqlparser::{
    dialect::{
        AnsiDialect, GenericDialect, MsSqlDialect, MySqlDialect, PostgreSqlDialect,
        SQLiteDialect,
    },
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
