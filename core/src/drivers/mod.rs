pub mod pg;
pub mod sqlite;
pub mod mysql;
pub mod mssql;

use crate::{
    connection::ConnectionConfig,
    error::CoreError,
    query::{ColumnInfo, IndexInfo, PageRequest, QueryResult, SchemaInfo, TableInfo},
};
use async_trait::async_trait;

/// Core trait every database driver must implement.
#[async_trait]
pub trait DbConnection: Send + Sync {
    /// Verify the connection is alive.
    async fn test_connection(&self) -> Result<(), CoreError>;

    /// List all databases visible to the current user.
    async fn list_databases(&self) -> Result<Vec<String>, CoreError>;

    /// List schemas within the current database.
    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, CoreError>;

    /// List tables (and views) within a schema.
    async fn list_tables(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, CoreError>;

    /// Get column + index metadata for a table.
    async fn describe_table(
        &self,
        schema: Option<&str>,
        table: &str,
    ) -> Result<(Vec<ColumnInfo>, Vec<IndexInfo>), CoreError>;

    /// Execute arbitrary SQL and return results.
    async fn execute_query(&self, sql: &str) -> Result<QueryResult, CoreError>;

    /// Fetch a paginated, optionally filtered page of rows from a table.
    async fn fetch_table_rows(
        &self,
        schema: Option<&str>,
        table: &str,
        page: &PageRequest,
        where_clause: Option<&str>,
    ) -> Result<QueryResult, CoreError>;

    /// Return total row count for a table with optional filter.
    async fn count_rows(
        &self,
        schema: Option<&str>,
        table: &str,
        where_clause: Option<&str>,
    ) -> Result<i64, CoreError>;
}

/// Create a boxed driver from a config. The password must be pre-populated.
pub async fn connect(config: &ConnectionConfig) -> Result<Box<dyn DbConnection>, CoreError> {
    use crate::connection::DbEngine;
    match config.engine {
        DbEngine::Postgres => {
            let driver = pg::PgDriver::connect(config).await?;
            Ok(Box::new(driver))
        }
        DbEngine::SQLite => {
            let driver = sqlite::SqliteDriver::connect(config).await?;
            Ok(Box::new(driver))
        }
        DbEngine::MySQL => {
            let driver = mysql::MySqlDriver::connect(config).await?;
            Ok(Box::new(driver))
        }
        DbEngine::MSSQL => {
            let driver = mssql::MssqlDriver::connect(config).await?;
            Ok(Box::new(driver))
        }
    }
}
