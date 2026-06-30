use std::time::Instant;

use async_trait::async_trait;
use sqlx::{mysql::MySqlPoolOptions, Column, MySqlPool, Row, TypeInfo, ValueRef};

use crate::{
    connection::ConnectionConfig,
    error::CoreError,
    query::{ColumnInfo, IndexInfo, PageRequest, QueryResult, RowValue, SchemaInfo, TableInfo},
};

use super::DbConnection;

pub struct MySqlDriver {
    pool: MySqlPool,
    database: String,
}

impl MySqlDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self, CoreError> {
        let url = config.connection_url();
        let pool = MySqlPoolOptions::new()
            .max_connections(10)
            .connect(&url)
            .await
            .map_err(|e| CoreError::Connection(e.to_string()))?;
        let database = config.database.clone().unwrap_or_default();
        Ok(Self { pool, database })
    }
}

fn mysql_value_to_row_value(row: &sqlx::mysql::MySqlRow, idx: usize) -> RowValue {
    let raw = row.try_get_raw(idx);
    if let Ok(raw_val) = raw {
        if raw_val.is_null() {
            return RowValue::Null;
        }
    }

    let col = row.column(idx);
    let type_name = col.type_info().name().to_uppercase();

    match type_name.as_str() {
        "BOOLEAN" | "BOOL" | "TINYINT(1)" => row
            .try_get::<bool, _>(idx)
            .map(RowValue::Bool)
            .unwrap_or_else(|_| {
                row.try_get::<i64, _>(idx)
                    .map(RowValue::Integer)
                    .unwrap_or(RowValue::Null)
            }),

        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" | "BIGINT" => row
            .try_get::<i64, _>(idx)
            .map(RowValue::Integer)
            .unwrap_or_else(|_| {
                row.try_get::<u64, _>(idx)
                    .map(|v| RowValue::Integer(v as i64))
                    .unwrap_or(RowValue::Null)
            }),

        "FLOAT" | "DOUBLE" | "DECIMAL" | "NUMERIC" | "REAL" => row
            .try_get::<f64, _>(idx)
            .map(RowValue::Float)
            .unwrap_or(RowValue::Null),

        "JSON" => row
            .try_get::<serde_json::Value, _>(idx)
            .map(RowValue::Json)
            .unwrap_or_else(|_| {
                row.try_get::<String, _>(idx)
                    .map(RowValue::Text)
                    .unwrap_or(RowValue::Null)
            }),

        "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BINARY" | "VARBINARY" => row
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

        _ => row
            .try_get::<String, _>(idx)
            .map(RowValue::Text)
            .unwrap_or(RowValue::Null),
    }
}

fn rows_to_query_result(
    rows: Vec<sqlx::mysql::MySqlRow>,
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
                .map(|idx| mysql_value_to_row_value(row, idx))
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
impl DbConnection for MySqlDriver {
    async fn test_connection(&self) -> Result<(), CoreError> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .map_err(|e| CoreError::Connection(e.to_string()))?;
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<String>, CoreError> {
        let rows = sqlx::query("SHOW DATABASES")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.iter().map(|r| r.get::<String, _>(0)).collect())
    }

    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, CoreError> {
        // MySQL uses databases as schemas
        let dbs = self.list_databases().await?;
        Ok(dbs.into_iter().map(|name| SchemaInfo { name }).collect())
    }

    async fn list_tables(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, CoreError> {
        let db = schema.unwrap_or(&self.database);
        let rows = sqlx::query(
            "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE \
             FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? \
             ORDER BY TABLE_NAME",
        )
        .bind(db)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .iter()
            .map(|r| TableInfo {
                schema: r.get::<String, _>(0),
                name: r.get::<String, _>(1),
                table_type: r
                    .get::<String, _>(2)
                    .to_lowercase()
                    .replace("base table", "table"),
                row_count_estimate: None,
            })
            .collect())
    }

    async fn describe_table(
        &self,
        schema: Option<&str>,
        table: &str,
    ) -> Result<(Vec<ColumnInfo>, Vec<IndexInfo>), CoreError> {
        let db = schema.unwrap_or(&self.database);

        let col_rows = sqlx::query(
            "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
                    CHARACTER_MAXIMUM_LENGTH, COLUMN_KEY
             FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
             ORDER BY ORDINAL_POSITION",
        )
        .bind(db)
        .bind(table)
        .fetch_all(&self.pool)
        .await?;

        let columns: Vec<ColumnInfo> = col_rows
            .iter()
            .map(|r| ColumnInfo {
                name: r.get::<String, _>(0),
                data_type: r.get::<String, _>(1),
                nullable: r.get::<String, _>(2) == "YES",
                default_value: r.try_get::<Option<String>, _>(3).ok().flatten(),
                max_length: r.try_get::<Option<i64>, _>(4).ok().flatten(),
                is_primary_key: r.get::<String, _>(5) == "PRI",
            })
            .collect();

        let idx_rows = sqlx::query(
            "SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX), \
                    NOT NON_UNIQUE, INDEX_NAME = 'PRIMARY'
             FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
             GROUP BY INDEX_NAME, NON_UNIQUE",
        )
        .bind(db)
        .bind(table)
        .fetch_all(&self.pool)
        .await?;

        let indexes: Vec<IndexInfo> = idx_rows
            .iter()
            .map(|r| {
                let cols_str: String = r.try_get::<String, _>(1).unwrap_or_default();
                IndexInfo {
                    name: r.get::<String, _>(0),
                    columns: cols_str.split(',').map(|s| s.to_string()).collect(),
                    is_unique: r.try_get::<i8, _>(2).map(|v| v != 0).unwrap_or(false),
                    is_primary: r.try_get::<i8, _>(3).map(|v| v != 0).unwrap_or(false),
                }
            })
            .collect();

        Ok((columns, indexes))
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult, CoreError> {
        let start = Instant::now();
        let sql_lower = sql.trim().to_lowercase();

        let is_fetch = sql_lower.starts_with("select")
            || sql_lower.starts_with("show")
            || sql_lower.starts_with("explain")
            || sql_lower.starts_with("with")
            || sql_lower.starts_with("describe")
            || sql_lower.starts_with("desc ");

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
        schema: Option<&str>,
        table: &str,
        page: &PageRequest,
        where_clause: Option<&str>,
    ) -> Result<QueryResult, CoreError> {
        let db = schema.unwrap_or(&self.database);
        let qualified = format!("`{}`.`{}`", db, table);

        let order = if let Some(col) = &page.order_by {
            let dir = if page.order_desc { "DESC" } else { "ASC" };
            format!("ORDER BY `{}` {}", col, dir)
        } else {
            String::new()
        };

        let where_str = where_clause
            .filter(|s| !s.trim().is_empty())
            .map(|s| format!("WHERE {}", s))
            .unwrap_or_default();

        let sql = format!(
            "SELECT * FROM {} {} {} LIMIT {} OFFSET {}",
            qualified, where_str, order, page.limit, page.offset
        );

        self.execute_query(&sql).await
    }

    async fn count_rows(
        &self,
        schema: Option<&str>,
        table: &str,
        where_clause: Option<&str>,
    ) -> Result<i64, CoreError> {
        let db = schema.unwrap_or(&self.database);
        let qualified = format!("`{}`.`{}`", db, table);
        let where_str = where_clause
            .filter(|s| !s.trim().is_empty())
            .map(|s| format!("WHERE {}", s))
            .unwrap_or_default();

        let sql = format!("SELECT COUNT(*) FROM {} {}", qualified, where_str);
        let row = sqlx::query(&sql)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| CoreError::Query(e.to_string()))?;
        Ok(row.get::<i64, _>(0))
    }
}
