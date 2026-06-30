use std::time::Instant;

use async_trait::async_trait;
use sqlx::{sqlite::SqlitePoolOptions, Column, Row, SqlitePool, TypeInfo, ValueRef};

use crate::{
    connection::ConnectionConfig,
    error::CoreError,
    query::{ColumnInfo, IndexInfo, PageRequest, QueryResult, RowValue, SchemaInfo, TableInfo},
};

use super::DbConnection;

pub struct SqliteDriver {
    pool: SqlitePool,
}

impl SqliteDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self, CoreError> {
        let url = config.connection_url();
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .map_err(|e| CoreError::Connection(e.to_string()))?;
        Ok(Self { pool })
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
        "REAL" | "DOUBLE" | "DOUBLE PRECISION" | "FLOAT" | "NUMERIC" | "DECIMAL" => row
            .try_get::<f64, _>(idx)
            .map(RowValue::Float)
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
        let col_sql = format!("PRAGMA table_info(\"{}\")", table);
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
            })
            .collect();

        let idx_list_sql = format!("PRAGMA index_list(\"{}\")", table);
        let idx_list = sqlx::query(&idx_list_sql).fetch_all(&self.pool).await?;

        let mut indexes: Vec<IndexInfo> = vec![];
        for idx_row in &idx_list {
            let idx_name: String = idx_row.get(1);
            let is_unique: i64 = idx_row.get(2);
            let origin: String = idx_row.try_get(3).unwrap_or_default();

            let info_sql = format!("PRAGMA index_info(\"{}\")", idx_name);
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
        let sql_lower = sql.trim().to_lowercase();

        let is_fetch = sql_lower.starts_with("select")
            || sql_lower.starts_with("pragma")
            || sql_lower.starts_with("explain")
            || sql_lower.starts_with("with");

        if is_fetch {
            let rows = sqlx::query(sql)
                .fetch_all(&self.pool)
                .await
                .map_err(|e| CoreError::Query(e.to_string()))?;
            let elapsed = start.elapsed();
            Ok(rows_to_query_result(rows, elapsed))
        } else {
            let result = sqlx::query(sql)
                .execute(&self.pool)
                .await
                .map_err(|e| CoreError::Query(e.to_string()))?;
            let elapsed = start.elapsed();
            let mut qr = QueryResult::from_duration(elapsed);
            qr.affected_rows = Some(result.rows_affected());
            Ok(qr)
        }
    }

    async fn fetch_table_rows(
        &self,
        _schema: Option<&str>,
        table: &str,
        page: &PageRequest,
        where_clause: Option<&str>,
    ) -> Result<QueryResult, CoreError> {
        let order = if let Some(col) = &page.order_by {
            let dir = if page.order_desc { "DESC" } else { "ASC" };
            format!("ORDER BY \"{}\" {}", col, dir)
        } else {
            String::new()
        };

        let where_str = where_clause
            .filter(|s| !s.trim().is_empty())
            .map(|s| format!("WHERE {}", s))
            .unwrap_or_default();

        let sql = format!(
            "SELECT * FROM \"{}\" {} {} LIMIT {} OFFSET {}",
            table, where_str, order, page.limit, page.offset
        );

        self.execute_query(&sql).await
    }

    async fn count_rows(
        &self,
        _schema: Option<&str>,
        table: &str,
        where_clause: Option<&str>,
    ) -> Result<i64, CoreError> {
        let where_str = where_clause
            .filter(|s| !s.trim().is_empty())
            .map(|s| format!("WHERE {}", s))
            .unwrap_or_default();

        let sql = format!("SELECT COUNT(*) FROM \"{}\" {}", table, where_str);
        let row = sqlx::query(&sql)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| CoreError::Query(e.to_string()))?;
        Ok(row.get::<i64, _>(0))
    }
}
