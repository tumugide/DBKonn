use std::str::FromStr;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Column, Row, SqlitePool, TypeInfo, ValueRef,
};
use tokio::sync::Mutex as TokioMutex;

use crate::{
    connection::{ConnectionConfig, DbEngine},
    error::CoreError,
    ident::quote_ident,
    query::{ColumnInfo, IndexInfo, PageRequest, QueryResult, RowValue, SchemaInfo, TableInfo},
    validator::validate_where_clause,
};

use super::DbConnection;

const ENGINE: DbEngine = DbEngine::SQLite;

pub struct SqliteDriver {
    pool: SqlitePool,
    txn: TokioMutex<Option<sqlx::Transaction<'static, sqlx::Sqlite>>>,
}

impl SqliteDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self, CoreError> {
        let path = config.file_path.as_deref().unwrap_or(":memory:");
        let is_memory = path.is_empty() || path == ":memory:";

        // Build options directly instead of formatting `sqlite://{path}` —
        // a path containing `?`, `#`, spaces, etc. would otherwise be parsed
        // as URL query/fragment and silently point at the wrong file.
        let options = if is_memory {
            SqliteConnectOptions::from_str("sqlite::memory:")
                .map_err(|e| CoreError::Connection(e.to_string()))?
        } else {
            SqliteConnectOptions::new().filename(path)
        }
        // Without a busy timeout, any concurrent write returns SQLITE_BUSY
        // immediately instead of waiting for the lock to clear.
        .busy_timeout(Duration::from_secs(5));

        let pool = SqlitePoolOptions::new()
            // A `:memory:` database is private to its connection, so a pool of
            // N connections would be N distinct empty databases. Pin it to 1.
            .max_connections(if is_memory { 1 } else { 5 })
            .connect_with(options)
            .await
            .map_err(|e| CoreError::Connection(e.to_string()))?;
        Ok(Self {
            pool,
            txn: TokioMutex::new(None),
        })
    }
}

fn sqlite_value_to_row_value(row: &sqlx::sqlite::SqliteRow, idx: usize) -> RowValue {
    let col = row.column(idx);
    let type_name = col.type_info().name().to_uppercase();

    let raw = row.try_get_raw(idx);
    if let Ok(raw_val) = raw {
        if raw_val.is_null() {
            return RowValue::Null;
        }
    }

    match type_name.as_str() {
        "BOOLEAN" => row
            .try_get::<bool, _>(idx)
            .map(RowValue::Bool)
            .unwrap_or(RowValue::Null),
        "INTEGER" | "INT" | "TINYINT" | "SMALLINT" | "MEDIUMINT" | "BIGINT"
        | "UNSIGNED BIG INT" | "INT2" | "INT8" => row
            .try_get::<i64, _>(idx)
            .map(RowValue::Integer)
            .unwrap_or(RowValue::Null),
        "REAL" | "DOUBLE" | "DOUBLE PRECISION" | "FLOAT" => row
            .try_get::<f64, _>(idx)
            .map(RowValue::Float)
            .unwrap_or(RowValue::Null),
        // DECIMAL/NUMERIC have no native SQLite type; values may be stored as
        // TEXT to keep exact precision. Prefer the string form, fall back to
        // the numeric affinities.
        "NUMERIC" | "DECIMAL" => row
            .try_get::<String, _>(idx)
            .map(RowValue::Text)
            .or_else(|_| row.try_get::<i64, _>(idx).map(RowValue::Integer))
            .or_else(|_| row.try_get::<f64, _>(idx).map(RowValue::Float))
            .unwrap_or(RowValue::Null),
        "BLOB" => row
            .try_get::<Vec<u8>, _>(idx)
            .map(|b| {
                let preview: String = b
                    .iter()
                    .take(16)
                    .map(|byte| format!("{:02x}", byte))
                    .collect::<Vec<_>>()
                    .join(" ");
                let suffix = if b.len() > 16 {
                    format!("… ({} bytes)", b.len())
                } else {
                    String::new()
                };
                RowValue::Binary(format!("0x{}{}", preview, suffix))
            })
            .unwrap_or(RowValue::Null),
        _ => {
            // NULL type means untyped — try integers and floats first
            if type_name == "NULL" {
                if let Ok(v) = row.try_get::<i64, _>(idx) {
                    return RowValue::Integer(v);
                }
                if let Ok(v) = row.try_get::<f64, _>(idx) {
                    return RowValue::Float(v);
                }
            }
            row.try_get::<String, _>(idx)
                .map(RowValue::Text)
                .unwrap_or(RowValue::Null)
        }
    }
}

fn rows_to_query_result(
    rows: Vec<sqlx::sqlite::SqliteRow>,
    elapsed: std::time::Duration,
) -> QueryResult {
    if rows.is_empty() {
        return QueryResult {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            execution_time_ms: elapsed.as_millis() as u64,
            error: None,
            affected_rows: None,
        };
    }

    let columns: Vec<ColumnInfo> = rows[0]
        .columns()
        .iter()
        .map(|col| ColumnInfo {
            name: col.name().to_string(),
            data_type: col.type_info().name().to_string(),
            nullable: true,
            is_primary_key: false,
            default_value: None,
            max_length: None,
            enum_values: None,
        })
        .collect();

    let data_rows: Vec<Vec<RowValue>> = rows
        .iter()
        .map(|row| {
            (0..row.columns().len())
                .map(|idx| sqlite_value_to_row_value(row, idx))
                .collect()
        })
        .collect();

    let row_count = data_rows.len();

    QueryResult {
        columns,
        rows: data_rows,
        row_count,
        execution_time_ms: elapsed.as_millis() as u64,
        error: None,
        affected_rows: None,
    }
}

#[async_trait]
impl DbConnection for SqliteDriver {
    async fn test_connection(&self) -> Result<(), CoreError> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .map_err(|e| CoreError::Connection(e.to_string()))?;
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<String>, CoreError> {
        // SQLite "databases" are the attached files; return the main one
        let rows = sqlx::query("PRAGMA database_list")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .iter()
            .map(|r| r.try_get::<String, _>(1).unwrap_or_default())
            .collect())
    }

    async fn create_database(&self, _name: &str) -> Result<(), CoreError> {
        Err(CoreError::Unsupported(
            "SQLite has no separate CREATE DATABASE — each database is its own file".into(),
        ))
    }

    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, CoreError> {
        Ok(vec![SchemaInfo {
            name: "main".to_string(),
        }])
    }

    async fn list_tables(&self, _schema: Option<&str>) -> Result<Vec<TableInfo>, CoreError> {
        let rows = sqlx::query(
            "SELECT name, type FROM sqlite_master \
             WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' \
             ORDER BY name",
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .iter()
            .map(|r| TableInfo {
                schema: "main".to_string(),
                name: r.get::<String, _>(0),
                table_type: r.get::<String, _>(1),
                row_count_estimate: None,
            })
            .collect())
    }

    async fn describe_table(
        &self,
        _schema: Option<&str>,
        table: &str,
    ) -> Result<(Vec<ColumnInfo>, Vec<IndexInfo>), CoreError> {
        let col_sql = format!("PRAGMA table_info({})", quote_ident(&ENGINE, table));
        let col_rows = sqlx::query(&col_sql).fetch_all(&self.pool).await?;

        let columns: Vec<ColumnInfo> = col_rows
            .iter()
            .map(|r| ColumnInfo {
                name: r.get::<String, _>(1),
                data_type: r.get::<String, _>(2),
                nullable: r.get::<i64, _>(3) == 0,
                default_value: r.try_get::<Option<String>, _>(4).ok().flatten(),
                is_primary_key: r.get::<i64, _>(5) > 0,
                max_length: None,
                enum_values: None,
            })
            .collect();

        let idx_list_sql = format!("PRAGMA index_list({})", quote_ident(&ENGINE, table));
        let idx_list = sqlx::query(&idx_list_sql).fetch_all(&self.pool).await?;

        let mut indexes: Vec<IndexInfo> = vec![];
        for idx_row in &idx_list {
            let idx_name: String = idx_row.get(1);
            let is_unique: i64 = idx_row.get(2);
            let origin: String = idx_row.try_get(3).unwrap_or_default();

            let info_sql = format!("PRAGMA index_info({})", quote_ident(&ENGINE, &idx_name));
            let info_rows = sqlx::query(&info_sql).fetch_all(&self.pool).await?;
            let cols: Vec<String> = info_rows
                .iter()
                .map(|r| r.get::<String, _>(2))
                .collect();

            indexes.push(IndexInfo {
                name: idx_name,
                columns: cols,
                is_unique: is_unique != 0,
                is_primary: origin == "pk",
            });
        }

        Ok((columns, indexes))
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult, CoreError> {
        let start = Instant::now();

        let mut txn_guard = self.txn.lock().await;
        let has_txn = txn_guard.is_some();

        macro_rules! run_fetch {
            ($executor:expr) => {{
                sqlx::query(sql)
                    .fetch_all($executor)
                    .await
                    .map_err(|e| CoreError::Query(e.to_string()))?
            }};
        }
        macro_rules! run_execute {
            ($executor:expr) => {{
                sqlx::query(sql)
                    .execute($executor)
                    .await
                    .map_err(|e| CoreError::Query(e.to_string()))?
            }};
        }

        let result = if crate::query::statement_returns_rows(sql) {
            if has_txn {
                let rows = run_fetch!(&mut **txn_guard.as_mut().unwrap());
                let elapsed = start.elapsed();
                rows_to_query_result(rows, elapsed)
            } else {
                let rows = run_fetch!(&self.pool);
                let elapsed = start.elapsed();
                rows_to_query_result(rows, elapsed)
            }
        } else if has_txn {
            // In transaction mode, use prepared statements (the transaction
            // executor) — the unprepared path can't be used on a Transaction.
            let exec_result = run_execute!(&mut **txn_guard.as_mut().unwrap());
            let elapsed = start.elapsed();
            let mut qr = QueryResult::from_duration(elapsed);
            qr.affected_rows = Some(exec_result.rows_affected());
            qr
        } else {
            // Run through the *unprepared* executor (`&str`, not
            // `sqlx::query(...)`). sqlx-sqlite's prepared path executes only
            // the first statement of a `;`-separated script and silently
            // ignores the rest; the unprepared path runs the whole batch.
            use sqlx::Executor;
            let result = self
                .pool
                .execute(sql)
                .await
                .map_err(|e| CoreError::Query(e.to_string()))?;
            let elapsed = start.elapsed();
            let mut qr = QueryResult::from_duration(elapsed);
            qr.affected_rows = Some(result.rows_affected());
            qr
        };

        drop(txn_guard);
        Ok(result)
    }

    async fn fetch_table_rows(
        &self,
        _schema: Option<&str>,
        table: &str,
        page: &PageRequest,
        where_clause: Option<&str>,
    ) -> Result<QueryResult, CoreError> {
        validate_where_clause(where_clause.unwrap_or(""), &ENGINE)?;

        let order = if let Some(col) = &page.order_by {
            let dir = if page.order_desc { "DESC" } else { "ASC" };
            format!("ORDER BY {} {}", quote_ident(&ENGINE, col), dir)
        } else {
            String::new()
        };

        let where_str = where_clause
            .filter(|s| !s.trim().is_empty())
            .map(|s| format!("WHERE {}", s))
            .unwrap_or_default();

        let sql = format!(
            "SELECT * FROM {} {} {} LIMIT {} OFFSET {}",
            quote_ident(&ENGINE, table),
            where_str,
            order,
            page.limit,
            page.offset
        );

        let mut result = self.execute_query(&sql).await?;
        if result.columns.is_empty() {
            let (cols, _) = self.describe_table(None, table).await?;
            result.columns = cols;
        }
        Ok(result)
    }

    async fn count_rows(
        &self,
        _schema: Option<&str>,
        table: &str,
        where_clause: Option<&str>,
    ) -> Result<i64, CoreError> {
        validate_where_clause(where_clause.unwrap_or(""), &ENGINE)?;

        let where_str = where_clause
            .filter(|s| !s.trim().is_empty())
            .map(|s| format!("WHERE {}", s))
            .unwrap_or_default();

        let sql = format!(
            "SELECT COUNT(*) FROM {} {}",
            quote_ident(&ENGINE, table),
            where_str
        );
        let row = sqlx::query(&sql)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| CoreError::Query(e.to_string()))?;
        Ok(row.get::<i64, _>(0))
    }

    async fn close(&self) {
        {
            let mut txn_guard = self.txn.lock().await;
            if let Some(txn) = txn_guard.take() {
                let _ = txn.rollback().await;
            }
        }
        self.pool.close().await;
    }

    async fn begin_transaction(&self) -> Result<(), CoreError> {
        let mut txn_guard = self.txn.lock().await;
        if txn_guard.is_some() {
            return Err(CoreError::Driver(
                "A transaction is already active".into(),
            ));
        }
        let txn = self
            .pool
            .begin()
            .await
            .map_err(|e| CoreError::Query(e.to_string()))?;
        *txn_guard = Some(txn);
        Ok(())
    }

    async fn commit_transaction(&self) -> Result<(), CoreError> {
        let mut txn_guard = self.txn.lock().await;
        let txn = txn_guard
            .take()
            .ok_or_else(|| CoreError::Driver("No active transaction".into()))?;
        txn.commit()
            .await
            .map_err(|e| CoreError::Query(e.to_string()))?;
        Ok(())
    }

    async fn rollback_transaction(&self) -> Result<(), CoreError> {
        let mut txn_guard = self.txn.lock().await;
        let txn = txn_guard
            .take()
            .ok_or_else(|| CoreError::Driver("No active transaction".into()))?;
        txn.rollback()
            .await
            .map_err(|e| CoreError::Query(e.to_string()))?;
        Ok(())
    }

    async fn in_transaction(&self) -> bool {
        self.txn.lock().await.is_some()
    }
}
