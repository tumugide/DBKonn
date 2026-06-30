use std::time::Instant;

use async_trait::async_trait;
use tiberius::{AuthMethod, Client, Config, Row};
use tokio::net::TcpStream;
use tokio_util::compat::TokioAsyncWriteCompatExt;

use crate::{
    connection::ConnectionConfig,
    error::CoreError,
    query::{ColumnInfo, IndexInfo, PageRequest, QueryResult, RowValue, SchemaInfo, TableInfo},
};

use super::DbConnection;

pub struct MssqlDriver {
    config: tiberius::Config,
    database: String,
}

impl MssqlDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self, CoreError> {
        let mut tib_config = Config::new();
        tib_config.host(config.host.as_deref().unwrap_or("localhost"));
        tib_config.port(config.port.unwrap_or(1433));

        if let Some(db) = &config.database {
            tib_config.database(db);
        }

        // SQL Server auth (only supported auth method on macOS without SSPI)
        let user = config.username.as_deref().unwrap_or("sa");
        let pass = config.password.as_deref().unwrap_or("");
        tib_config.authentication(AuthMethod::sql_server(user, pass));

        // Trust server cert for development; flag in UI for production use
        tib_config.trust_cert();

        // Test connect to ensure credentials are valid
        let tcp = TcpStream::connect(tib_config.get_addr())
            .await
            .map_err(|e| CoreError::Connection(format!("TCP connect failed: {}", e)))?;
        tcp.set_nodelay(true).ok();

        let _client = Client::connect(tib_config.clone(), tcp.compat_write())
            .await
            .map_err(|e| CoreError::Connection(e.to_string()))?;

        Ok(Self {
            config: tib_config,
            database: config.database.clone().unwrap_or_default(),
        })
    }

    async fn get_client(&self) -> Result<Client<tokio_util::compat::Compat<TcpStream>>, CoreError> {
        let tcp = TcpStream::connect(self.config.get_addr())
            .await
            .map_err(|e| CoreError::Connection(format!("TCP connect failed: {}", e)))?;
        tcp.set_nodelay(true).ok();

        Client::connect(self.config.clone(), tcp.compat_write())
            .await
            .map_err(|e| CoreError::Connection(e.to_string()))
    }
}

/// Extract typed values from a tiberius Row.
/// tiberius Row::get() returns Option<T> (not Result).
fn tiberius_row_to_values(row: &Row) -> Vec<RowValue> {
    (0..row.len())
        .map(|i| {
            // Try string first
            if let Some(s) = row.get::<&str, _>(i) {
                return RowValue::Text(s.to_string());
            }
            if let Some(v) = row.get::<i64, _>(i) {
                return RowValue::Integer(v);
            }
            if let Some(v) = row.get::<i32, _>(i) {
                return RowValue::Integer(v as i64);
            }
            if let Some(v) = row.get::<i16, _>(i) {
                return RowValue::Integer(v as i64);
            }
            if let Some(v) = row.get::<f64, _>(i) {
                return RowValue::Float(v);
            }
            if let Some(v) = row.get::<f32, _>(i) {
                return RowValue::Float(v as f64);
            }
            if let Some(v) = row.get::<bool, _>(i) {
                return RowValue::Bool(v);
            }
            if let Some(b) = row.get::<&[u8], _>(i) {
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
                return RowValue::Binary(format!("0x{}{}", preview, suffix));
            }
            RowValue::Null
        })
        .collect()
}

fn tiberius_rows_to_query_result(
    col_names: Vec<String>,
    col_types: Vec<String>,
    rows: Vec<Vec<RowValue>>,
    elapsed: std::time::Duration,
) -> QueryResult {
    let columns: Vec<ColumnInfo> = col_names
        .into_iter()
        .zip(col_types.into_iter())
        .map(|(name, data_type)| ColumnInfo {
            name,
            data_type,
            nullable: true,
            is_primary_key: false,
            default_value: None,
            max_length: None,
        })
        .collect();

    let row_count = rows.len();

    QueryResult {
        columns,
        rows,
        row_count,
        execution_time_ms: elapsed.as_millis() as u64,
        error: None,
        affected_rows: None,
    }
}

#[async_trait]
impl DbConnection for MssqlDriver {
    async fn test_connection(&self) -> Result<(), CoreError> {
        let mut client = self.get_client().await?;
        client
            .simple_query("SELECT 1")
            .await
            .map_err(|e| CoreError::Connection(e.to_string()))?;
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<String>, CoreError> {
        let mut client = self.get_client().await?;
        let stream = client
            .simple_query("SELECT name FROM sys.databases ORDER BY name")
            .await
            .map_err(|e| CoreError::Query(e.to_string()))?;

        let rows = stream
            .into_first_result()
            .await
            .map_err(|e| CoreError::Query(e.to_string()))?;

        Ok(rows
            .iter()
            .filter_map(|r| r.get::<&str, _>(0))
            .map(|s| s.to_string())
            .collect())
    }

    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, CoreError> {
        let mut client = self.get_client().await?;
        let stream = client
            .simple_query(
                "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name",
            )
            .await
            .map_err(|e| CoreError::Query(e.to_string()))?;

        let rows = stream
            .into_first_result()
            .await
            .map_err(|e| CoreError::Query(e.to_string()))?;

        Ok(rows
            .iter()
            .filter_map(|r| r.get::<&str, _>(0))
            .map(|s| SchemaInfo { name: s.to_string() })
            .collect())
    }

    async fn list_tables(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, CoreError> {
        let schema = schema.unwrap_or("dbo");
        let mut client = self.get_client().await?;
        let sql = format!(
            "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE \
             FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = '{}' \
             ORDER BY TABLE_NAME",
            schema
        );

        let stream = client
            .simple_query(&sql)
            .await
            .map_err(|e| CoreError::Query(e.to_string()))?;

        let rows = stream
            .into_first_result()
            .await
            .map_err(|e| CoreError::Query(e.to_string()))?;

        Ok(rows
            .iter()
            .map(|r| TableInfo {
                schema: r.get::<&str, _>(0).unwrap_or("").to_string(),
                name: r.get::<&str, _>(1).unwrap_or("").to_string(),
                table_type: r
                    .get::<&str, _>(2)
                    .unwrap_or("")
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
        let schema = schema.unwrap_or("dbo");
        let mut client = self.get_client().await?;

        let col_sql = format!(
            "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT,
                    c.CHARACTER_MAXIMUM_LENGTH,
                    CAST(CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS BIT) AS IS_PK
             FROM information_schema.COLUMNS c
             LEFT JOIN (
                 SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME
                 FROM information_schema.TABLE_CONSTRAINTS tc
                 JOIN information_schema.KEY_COLUMN_USAGE ku
                   ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
                   AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA
                 WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
             ) pk ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA
                  AND pk.TABLE_NAME = c.TABLE_NAME
                  AND pk.COLUMN_NAME = c.COLUMN_NAME
             WHERE c.TABLE_SCHEMA = '{}' AND c.TABLE_NAME = '{}'
             ORDER BY c.ORDINAL_POSITION",
            schema, table
        );

        let stream = client
            .simple_query(&col_sql)
            .await
            .map_err(|e| CoreError::Query(e.to_string()))?;

        let col_rows = stream
            .into_first_result()
            .await
            .map_err(|e| CoreError::Query(e.to_string()))?;

        let columns: Vec<ColumnInfo> = col_rows
            .iter()
            .map(|r| ColumnInfo {
                name: r.get::<&str, _>(0).unwrap_or("").to_string(),
                data_type: r.get::<&str, _>(1).unwrap_or("").to_string(),
                nullable: r.get::<&str, _>(2).unwrap_or("YES") == "YES",
                default_value: r.get::<&str, _>(3).map(|s| s.to_string()),
                max_length: r.get::<i64, _>(4),
                is_primary_key: r.get::<bool, _>(5).unwrap_or(false),
            })
            .collect();

        // Indexes
        let idx_sql = format!(
            "SELECT i.name, COL_NAME(ic.object_id, ic.column_id), i.is_unique, i.is_primary_key
             FROM sys.indexes i
             JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
             JOIN sys.tables t ON i.object_id = t.object_id
             JOIN sys.schemas s ON t.schema_id = s.schema_id
             WHERE s.name = '{}' AND t.name = '{}'
             ORDER BY i.name, ic.key_ordinal",
            schema, table
        );

        let stream2 = client
            .simple_query(&idx_sql)
            .await
            .map_err(|e| CoreError::Query(e.to_string()))?;

        let idx_rows = stream2
            .into_first_result()
            .await
            .map_err(|e| CoreError::Query(e.to_string()))?;

        // Group columns by index name
        let mut index_map: std::collections::HashMap<String, IndexInfo> =
            std::collections::HashMap::new();
        for r in &idx_rows {
            let Some(name) = r.get::<&str, _>(0) else { continue };
            let col  = r.get::<&str, _>(1).unwrap_or("").to_string();
            let is_unique  = r.get::<bool, _>(2).unwrap_or(false);
            let is_primary = r.get::<bool, _>(3).unwrap_or(false);

            let entry = index_map.entry(name.to_string()).or_insert(IndexInfo {
                name: name.to_string(),
                columns: vec![],
                is_unique,
                is_primary,
            });
            entry.columns.push(col);
        }

        Ok((columns, index_map.into_values().collect()))
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult, CoreError> {
        let start = Instant::now();
        let mut client = self.get_client().await?;

        let sql_lower = sql.trim().to_lowercase();
        let is_fetch = sql_lower.starts_with("select")
            || sql_lower.starts_with("with")
            || sql_lower.starts_with("exec")
            || sql_lower.starts_with("explain");

        if is_fetch {
            let stream = client
                .simple_query(sql)
                .await
                .map_err(|e| CoreError::Query(e.to_string()))?;

            let result_set = stream
                .into_results()
                .await
                .map_err(|e| CoreError::Query(e.to_string()))?;

            let elapsed = start.elapsed();

            if let Some(rows) = result_set.into_iter().next() {
                if rows.is_empty() {
                    return Ok(QueryResult::from_duration(elapsed));
                }

                let col_names: Vec<String> = rows[0]
                    .columns()
                    .iter()
                    .map(|c| c.name().to_string())
                    .collect();
                let col_types: Vec<String> = rows[0]
                    .columns()
                    .iter()
                    .map(|c| format!("{:?}", c.column_type()))
                    .collect();

                let data_rows: Vec<Vec<RowValue>> =
                    rows.iter().map(tiberius_row_to_values).collect();

                Ok(tiberius_rows_to_query_result(
                    col_names, col_types, data_rows, elapsed,
                ))
            } else {
                Ok(QueryResult::from_duration(elapsed))
            }
        } else {
            client
                .execute(sql, &[])
                .await
                .map_err(|e| CoreError::Query(e.to_string()))?;
            let elapsed = start.elapsed();
            Ok(QueryResult::from_duration(elapsed))
        }
    }

    async fn fetch_table_rows(
        &self,
        schema: Option<&str>,
        table: &str,
        page: &PageRequest,
        where_clause: Option<&str>,
    ) -> Result<QueryResult, CoreError> {
        let schema = schema.unwrap_or("dbo");
        let qualified = format!("[{}].[{}]", schema, table);

        let order = if let Some(col) = &page.order_by {
            let dir = if page.order_desc { "DESC" } else { "ASC" };
            format!("ORDER BY [{}] {}", col, dir)
        } else {
            // MSSQL requires ORDER BY for OFFSET/FETCH
            "ORDER BY (SELECT NULL)".to_string()
        };

        let where_str = where_clause
            .filter(|s| !s.trim().is_empty())
            .map(|s| format!("WHERE {}", s))
            .unwrap_or_default();

        let sql = format!(
            "SELECT * FROM {} {} {} OFFSET {} ROWS FETCH NEXT {} ROWS ONLY",
            qualified, where_str, order, page.offset, page.limit
        );

        self.execute_query(&sql).await
    }

    async fn count_rows(
        &self,
        schema: Option<&str>,
        table: &str,
        where_clause: Option<&str>,
    ) -> Result<i64, CoreError> {
        let schema = schema.unwrap_or("dbo");
        let qualified = format!("[{}].[{}]", schema, table);
        let where_str = where_clause
            .filter(|s| !s.trim().is_empty())
            .map(|s| format!("WHERE {}", s))
            .unwrap_or_default();

        let sql = format!("SELECT COUNT(*) FROM {} {}", qualified, where_str);
        let result = self.execute_query(&sql).await?;
        if let Some(row) = result.rows.first() {
            if let Some(val) = row.first() {
                if let RowValue::Integer(n) = val {
                    return Ok(*n);
                }
            }
        }
        Ok(0)
    }
}
