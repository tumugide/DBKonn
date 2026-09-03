use std::time::Instant;

use async_trait::async_trait;
use tiberius::{AuthMethod, Client, ColumnType, Config, FromSql, Row};
use tokio::net::TcpStream;
use tokio_util::compat::TokioAsyncWriteCompatExt;

use crate::{
    connection::{ConnectionConfig, DbEngine, SslMode},
    error::CoreError,
    ident::quote_ident,
    query::{ColumnInfo, IndexInfo, PageRequest, QueryResult, RowValue, SchemaInfo, TableInfo},
    validator::validate_where_clause,
};

use super::DbConnection;

const ENGINE: DbEngine = DbEngine::MSSQL;

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

        // `tiberius::Config::default()` sets `EncryptionLevel::Required`
        // regardless of what we pass it, so without this, selecting
        // "Disable" in the UI had no effect: every connection still
        // demanded TLS and failed against servers that don't offer it.
        tib_config.encryption(match config.ssl_mode {
            SslMode::Disable => tiberius::EncryptionLevel::NotSupported,
            SslMode::Prefer => tiberius::EncryptionLevel::On,
            SslMode::Require => tiberius::EncryptionLevel::Required,
        });

        // Only skip certificate verification when the user has NOT asked for
        // authenticated transport. On "Require" we keep tiberius's default
        // trust (the OS root store) so a man-in-the-middle presenting a
        // self-signed cert is rejected instead of silently accepted.
        // Support for a user-supplied CA / client cert is a follow-up.
        match config.ssl_mode {
            SslMode::Disable | SslMode::Prefer => tib_config.trust_cert(),
            SslMode::Require => {}
        }

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

    // TODO: opens a fresh TCP connection + tiberius handshake on every call —
    // no connection pooling. Fine for now, but a real perf/resource concern
    // under load.
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

/// Extract typed values from a tiberius Row, dispatching on each column's
/// actual TDS type so we always request the matching Rust type from
/// `try_get`. NEVER use `Row::get()` here: it panics via an internal
/// `.unwrap()` whenever the requested type doesn't match the column's real
/// type (tiberius's `FromSql::from_sql` returns `Err`, not `Ok(None)`, on a
/// type mismatch) — blindly trying `&str` first on every column, as this
/// function used to, panics on any non-string column (an INT id, a BIT flag,
/// any datetime, etc.), i.e. on nearly every real query.
fn tiberius_row_to_values(row: &Row) -> Vec<RowValue> {
    row.columns()
        .iter()
        .enumerate()
        .map(|(i, col)| tiberius_cell_to_row_value(row, i, col.column_type()))
        .collect()
}

/// Decode a single tiberius cell into a `RowValue`, dispatching on the
/// column's actual `ColumnType`. Uses `try_get` throughout (never the
/// panicking `get`), so a decode error becomes `RowValue::Null` (logged)
/// instead of crashing the query.
fn tiberius_cell_to_row_value(row: &Row, i: usize, col_type: ColumnType) -> RowValue {
    fn decode<'a, T, F>(row: &'a Row, i: usize, f: F) -> RowValue
    where
        T: FromSql<'a>,
        F: FnOnce(T) -> RowValue,
    {
        match row.try_get::<T, _>(i) {
            Ok(Some(v)) => f(v),
            Ok(None) => RowValue::Null,
            Err(e) => {
                tracing::warn!("mssql: column {} decode error: {}", i, e);
                RowValue::Null
            }
        }
    }

    fn binary_preview(b: &[u8]) -> RowValue {
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
    }

    match col_type {
        ColumnType::Null => RowValue::Null,

        ColumnType::Bit | ColumnType::Bitn => decode::<bool, _>(row, i, RowValue::Bool),

        ColumnType::Int1 => decode::<u8, _>(row, i, |v| RowValue::Integer(v as i64)),
        ColumnType::Int2 => decode::<i16, _>(row, i, |v| RowValue::Integer(v as i64)),
        ColumnType::Int4 => decode::<i32, _>(row, i, |v| RowValue::Integer(v as i64)),
        ColumnType::Int8 => decode::<i64, _>(row, i, RowValue::Integer),
        // Variable-width integer of unresolved size — try widest first.
        ColumnType::Intn => match row.try_get::<i64, _>(i) {
            Ok(Some(v)) => RowValue::Integer(v),
            _ => match row.try_get::<i32, _>(i) {
                Ok(Some(v)) => RowValue::Integer(v as i64),
                _ => match row.try_get::<i16, _>(i) {
                    Ok(Some(v)) => RowValue::Integer(v as i64),
                    _ => match row.try_get::<u8, _>(i) {
                        Ok(Some(v)) => RowValue::Integer(v as i64),
                        _ => RowValue::Null,
                    },
                },
            },
        },

        ColumnType::Float4 => decode::<f32, _>(row, i, |v| RowValue::Float(v as f64)),
        // Money/Money4 decode into ColumnData::F64 in tiberius, so f64 is the
        // correct target type — not a separate numeric representation.
        ColumnType::Float8 | ColumnType::Money | ColumnType::Money4 => {
            decode::<f64, _>(row, i, RowValue::Float)
        }
        ColumnType::Floatn => match row.try_get::<f64, _>(i) {
            Ok(Some(v)) => RowValue::Float(v),
            _ => match row.try_get::<f32, _>(i) {
                Ok(Some(v)) => RowValue::Float(v as f64),
                _ => RowValue::Null,
            },
        },

        ColumnType::Guid => decode::<tiberius::Uuid, _>(row, i, |v| RowValue::Text(v.to_string())),

        // tiberius's own `Numeric` type (unconditionally available) — not
        // `rust_decimal::Decimal`, which requires tiberius's separate
        // "rust_decimal" feature that isn't enabled here.
        ColumnType::Decimaln | ColumnType::Numericn => {
            decode::<tiberius::numeric::Numeric, _>(row, i, |v| RowValue::Text(v.to_string()))
        }

        ColumnType::Datetime
        | ColumnType::Datetime4
        | ColumnType::Datetimen
        | ColumnType::Datetime2 => decode::<chrono::NaiveDateTime, _>(row, i, |dt| {
            RowValue::Text(dt.format("%Y-%m-%d %H:%M:%S%.6f").to_string())
        }),
        ColumnType::Daten => decode::<chrono::NaiveDate, _>(row, i, |d| RowValue::Text(d.to_string())),
        ColumnType::Timen => decode::<chrono::NaiveTime, _>(row, i, |t| RowValue::Text(t.to_string())),
        ColumnType::DatetimeOffsetn => {
            decode::<chrono::DateTime<chrono::FixedOffset>, _>(row, i, |dt| {
                RowValue::Text(dt.to_rfc3339())
            })
        }

        ColumnType::BigVarChar
        | ColumnType::BigChar
        | ColumnType::NVarchar
        | ColumnType::NChar
        | ColumnType::Text
        | ColumnType::NText => decode::<&str, _>(row, i, |s| RowValue::Text(s.to_string())),

        ColumnType::BigVarBin | ColumnType::BigBinary | ColumnType::Image => {
            decode::<&[u8], _>(row, i, |b| binary_preview(b))
        }

        // Xml, Udt, SSVariant: no direct FromSql target wired up — fall
        // through to Null gracefully rather than crashing.
        ColumnType::Xml | ColumnType::Udt | ColumnType::SSVariant => RowValue::Null,
    }
}

/// Map a tiberius `ColumnType` (a TDS wire tag) to a readable SQL type name
/// for the result grid header. The grid used to show the raw `{:?}` debug
/// form (`BigVarChar`, `Intn`, …), which leaked internal tag names.
fn mssql_type_name(ct: ColumnType) -> &'static str {
    match ct {
        ColumnType::Null => "null",
        ColumnType::Bit | ColumnType::Bitn => "bit",
        ColumnType::Int1 => "tinyint",
        ColumnType::Int2 => "smallint",
        ColumnType::Int4 => "int",
        ColumnType::Int8 => "bigint",
        ColumnType::Intn => "int",
        ColumnType::Float4 => "real",
        ColumnType::Float8 => "float",
        ColumnType::Floatn => "float",
        ColumnType::Money | ColumnType::Money4 => "money",
        ColumnType::Decimaln | ColumnType::Numericn => "decimal",
        ColumnType::Guid => "uniqueidentifier",
        ColumnType::Datetime | ColumnType::Datetime4 | ColumnType::Datetimen => "datetime",
        ColumnType::Datetime2 => "datetime2",
        ColumnType::Daten => "date",
        ColumnType::Timen => "time",
        ColumnType::DatetimeOffsetn => "datetimeoffset",
        ColumnType::BigVarChar => "varchar",
        ColumnType::BigChar => "char",
        ColumnType::NVarchar => "nvarchar",
        ColumnType::NChar => "nchar",
        ColumnType::Text => "text",
        ColumnType::NText => "ntext",
        ColumnType::BigVarBin => "varbinary",
        ColumnType::BigBinary => "binary",
        ColumnType::Image => "image",
        ColumnType::Xml => "xml",
        ColumnType::Udt => "udt",
        ColumnType::SSVariant => "sql_variant",
    }
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
            enum_values: None,
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

    async fn create_database(&self, name: &str) -> Result<(), CoreError> {
        super::validate_db_name(name)?;
        let mut client = self.get_client().await?;
        client
            .simple_query(&format!("CREATE DATABASE [{name}]"))
            .await
            .map_err(|e| CoreError::Query(e.to_string()))?;
        Ok(())
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

        let stream = client
            .query(
                "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE \
                 FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = @P1 \
                 ORDER BY TABLE_NAME",
                &[&schema],
            )
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

        let stream = client
            .query(
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
                 WHERE c.TABLE_SCHEMA = @P1 AND c.TABLE_NAME = @P2
                 ORDER BY c.ORDINAL_POSITION",
                &[&schema, &table],
            )
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
                // CHARACTER_MAXIMUM_LENGTH is `int` (i32) on SQL Server;
                // asking tiberius for i64 always failed → always None.
                max_length: r.get::<i32, _>(4).map(|v| v as i64),
                is_primary_key: r.get::<bool, _>(5).unwrap_or(false),
                enum_values: None,
            })
            .collect();

        // Indexes
        let stream2 = client
            .query(
                "SELECT i.name, COL_NAME(ic.object_id, ic.column_id), i.is_unique, i.is_primary_key
                 FROM sys.indexes i
                 JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                 JOIN sys.tables t ON i.object_id = t.object_id
                 JOIN sys.schemas s ON t.schema_id = s.schema_id
                 WHERE s.name = @P1 AND t.name = @P2
                 ORDER BY i.name, ic.key_ordinal",
                &[&schema, &table],
            )
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

        if crate::query::statement_returns_rows(sql) {
            let stream = client
                .simple_query(sql)
                .await
                .map_err(|e| CoreError::Query(e.to_string()))?;

            let result_set = stream
                .into_results()
                .await
                .map_err(|e| CoreError::Query(e.to_string()))?;

            let elapsed = start.elapsed();

            // Skip leading empty result sets (e.g. from a `SET`/`PRINT` before
            // the real SELECT) instead of blindly taking the first and
            // reporting no rows.
            if let Some(rows) = result_set.into_iter().find(|rs| !rs.is_empty()) {
                let col_names: Vec<String> = rows[0]
                    .columns()
                    .iter()
                    .map(|c| c.name().to_string())
                    .collect();
                let col_types: Vec<String> = rows[0]
                    .columns()
                    .iter()
                    .map(|c| mssql_type_name(c.column_type()).to_string())
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
            let result = client
                .execute(sql, &[])
                .await
                .map_err(|e| CoreError::Query(e.to_string()))?;
            let elapsed = start.elapsed();
            let mut qr = QueryResult::from_duration(elapsed);
            // Sum the per-statement counts so the UI can report "N rows
            // affected" like the pooled engines do.
            qr.affected_rows = Some(result.rows_affected().iter().sum());
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
        validate_where_clause(where_clause.unwrap_or(""), &ENGINE)?;

        let schema = schema.unwrap_or("dbo");
        let qualified = format!(
            "{}.{}",
            quote_ident(&ENGINE, schema),
            quote_ident(&ENGINE, table)
        );

        let order = if let Some(col) = &page.order_by {
            let dir = if page.order_desc { "DESC" } else { "ASC" };
            format!("ORDER BY {} {}", quote_ident(&ENGINE, col), dir)
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

        let mut result = self.execute_query(&sql).await?;
        if result.columns.is_empty() {
            let (cols, _) = self.describe_table(Some(schema), table).await?;
            result.columns = cols;
        }
        Ok(result)
    }

    async fn count_rows(
        &self,
        schema: Option<&str>,
        table: &str,
        where_clause: Option<&str>,
    ) -> Result<i64, CoreError> {
        validate_where_clause(where_clause.unwrap_or(""), &ENGINE)?;

        let schema = schema.unwrap_or("dbo");
        let qualified = format!(
            "{}.{}",
            quote_ident(&ENGINE, schema),
            quote_ident(&ENGINE, table)
        );
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
