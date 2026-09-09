use std::time::Instant;

use async_trait::async_trait;
use sqlx::{mysql::MySqlPoolOptions, Column, MySqlPool, Row, TypeInfo, ValueRef};
use tokio::sync::Mutex as TokioMutex;

use crate::{
    alter::{self, AlterRequest},
    connection::{ConnectionConfig, DbEngine},
    error::CoreError,
    ident::{quote_ident, render_keyset_value},
    query::{
        ColumnInfo, ForeignKeyInfo, IndexInfo, PageRequest, QueryResult, RowValue, SchemaInfo,
        TableInfo,
    },
    validator::validate_where_clause,
};

use super::DbConnection;

const ENGINE: DbEngine = DbEngine::MySQL;

pub struct MySqlDriver {
    pool: MySqlPool,
    database: String,
    txn: TokioMutex<Option<sqlx::Transaction<'static, sqlx::MySql>>>,
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
        Ok(Self {
            pool,
            database,
            txn: TokioMutex::new(None),
        })
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

        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" | "BIGINT" | "YEAR" => row
            .try_get::<i64, _>(idx)
            .map(RowValue::Integer)
            .unwrap_or_else(|_| {
                row.try_get::<u64, _>(idx)
                    .map(|v| RowValue::Integer(v as i64))
                    .unwrap_or(RowValue::Null)
            }),

        "FLOAT" | "DOUBLE" | "REAL" => row
            .try_get::<f64, _>(idx)
            .map(RowValue::Float)
            .unwrap_or(RowValue::Null),

        // Keep full precision — never round a fixed-point column through f64.
        "DECIMAL" | "NUMERIC" | "NEWDECIMAL" => row
            .try_get::<rust_decimal::Decimal, _>(idx)
            .map(|d| RowValue::Text(d.to_string()))
            .unwrap_or_else(|_| {
                row.try_get::<String, _>(idx)
                    .map(RowValue::Text)
                    .unwrap_or(RowValue::Null)
            }),

        // Temporal types have no `String` decoder in sqlx's binary protocol —
        // the old catch-all `try_get::<String>` failed the strict type check
        // and every DATE/DATETIME/TIMESTAMP/TIME cell rendered as NULL.
        "DATE" => row
            .try_get::<chrono::NaiveDate, _>(idx)
            .map(|d| RowValue::Text(d.to_string()))
            .unwrap_or(RowValue::Null),

        "DATETIME" => row
            .try_get::<chrono::NaiveDateTime, _>(idx)
            .map(|dt| RowValue::Text(dt.format("%Y-%m-%d %H:%M:%S%.6f").to_string()))
            .unwrap_or(RowValue::Null),

        "TIMESTAMP" => row
            .try_get::<chrono::DateTime<chrono::Utc>, _>(idx)
            .map(|dt| RowValue::Text(dt.to_rfc3339()))
            .unwrap_or_else(|_| {
                row.try_get::<chrono::NaiveDateTime, _>(idx)
                    .map(|dt| RowValue::Text(dt.format("%Y-%m-%d %H:%M:%S%.6f").to_string()))
                    .unwrap_or(RowValue::Null)
            }),

        "TIME" => row
            .try_get::<chrono::NaiveTime, _>(idx)
            .map(|t| RowValue::Text(t.to_string()))
            .unwrap_or_else(|_| {
                // MySQL TIME can be negative or exceed 24h, which NaiveTime
                // can't represent — fall back to the raw text form.
                row.try_get_unchecked::<String, _>(idx)
                    .map(RowValue::Text)
                    .unwrap_or(RowValue::Null)
            }),

        "BIT" => row
            .try_get::<u64, _>(idx)
            .map(|v| RowValue::Integer(v as i64))
            .unwrap_or_else(|_| {
                row.try_get::<bool, _>(idx)
                    .map(RowValue::Bool)
                    .unwrap_or(RowValue::Null)
            }),

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
            enum_values: None,
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

    async fn create_database(&self, name: &str) -> Result<(), CoreError> {
        super::validate_db_name(name)?;
        sqlx::query(&format!("CREATE DATABASE `{name}`"))
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, CoreError> {
        // MySQL uses databases as schemas
        let dbs = self.list_databases().await?;
        Ok(dbs.into_iter().map(|name| SchemaInfo { name }).collect())
    }

    async fn list_tables(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, CoreError> {
        let db = schema.unwrap_or(&self.database);
        // Tables + views from TABLES, functions/procedures from ROUTINES,
        // and triggers from TRIGGERS, unioned so the sidebar can browse all
        // of them. TYPE names are normalized to lower case ("BASE TABLE" →
        // "table").
        let rows = sqlx::query(
            "SELECT obj_schema, obj_name, obj_type, obj_rows FROM (
                SELECT TABLE_SCHEMA AS obj_schema, TABLE_NAME AS obj_name,
                       TABLE_TYPE AS obj_type, TABLE_ROWS AS obj_rows
                FROM information_schema.TABLES
                UNION ALL
                SELECT ROUTINE_SCHEMA, ROUTINE_NAME, LOWER(ROUTINE_TYPE), NULL
                FROM information_schema.ROUTINES
                UNION ALL
                SELECT TRIGGER_SCHEMA, TRIGGER_NAME, 'trigger', NULL
                FROM information_schema.TRIGGERS
            ) objs
            WHERE obj_schema = ?
            ORDER BY obj_name",
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
                // TABLE_ROWS is an estimate for InnoDB, NULL for other kinds.
                row_count_estimate: r
                    .try_get::<Option<i64>, _>(3)
                    .ok()
                    .flatten()
                    .or_else(|| {
                        r.try_get::<Option<u64>, _>(3)
                            .ok()
                            .flatten()
                            .map(|v| v as i64)
                    }),
            })
            .collect())
    }

    async fn get_object_ddl(
        &self,
        schema: Option<&str>,
        name: &str,
        object_type: &str,
    ) -> Result<String, CoreError> {
        let db = schema.unwrap_or(&self.database);
        let qualified = format!(
            "{}.{}",
            quote_ident(&ENGINE, db),
            quote_ident(&ENGINE, name)
        );

        match object_type {
            // SHOW CREATE VIEW's definition lives in column 2 (index 1).
            "view" => {
                let row = sqlx::query(&format!("SHOW CREATE VIEW {}", qualified))
                    .fetch_one(&self.pool)
                    .await?;
                row.try_get::<String, _>(1)
                    .map_err(|e| CoreError::Query(format!("Missing SHOW CREATE VIEW result: {}", e)))
            }
            // The CREATE FUNCTION / PROCEDURE columns are index 2 for both.
            "function" | "procedure" => {
                let kw = if object_type == "function" {
                    "FUNCTION"
                } else {
                    "PROCEDURE"
                };
                let row = sqlx::query(&format!("SHOW CREATE {kw} {}", qualified))
                    .fetch_one(&self.pool)
                    .await?;
                row.try_get::<String, _>(2)
                    .map_err(|e| CoreError::Query(format!("Missing SHOW CREATE {kw} result: {}", e)))
            }
            // SHOW CREATE TRIGGER's columns vary across MySQL/MariaDB
            // versions, so rebuild the DDL from information_schema.TRIGGERS
            // instead — that shape is stable.
            "trigger" => {
                let row = sqlx::query(
                    "SELECT ACTION_TIMING, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_STATEMENT \
                     FROM information_schema.TRIGGERS \
                     WHERE TRIGGER_SCHEMA = ? AND TRIGGER_NAME = ?",
                )
                .bind(db)
                .bind(name)
                .fetch_optional(&self.pool)
                .await?
                .ok_or_else(|| CoreError::Query(format!("No trigger named {name}")))?;
                let timing: String = row.get(0);
                let event: String = row.get(1);
                let table: String = row.get(2);
                let statement: String = row.get(3);
                Ok(format!(
                    "CREATE TRIGGER {} {} {} ON {} FOR EACH ROW\n{}",
                    quote_ident(&ENGINE, name),
                    timing,
                    event,
                    quote_ident(&ENGINE, &table),
                    statement
                ))
            }
            other => Err(CoreError::Unsupported(format!(
                "MySQL DDL reconstruction is not supported for '{other}' objects"
            ))),
        }
    }

    async fn describe_table(
        &self,
        schema: Option<&str>,
        table: &str,
    ) -> Result<(Vec<ColumnInfo>, Vec<IndexInfo>), CoreError> {
        let db = schema.unwrap_or(&self.database);

        let col_rows = sqlx::query(
            "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
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
            .map(|r| {
                let column_type: String = r.get(2);
                let enum_values = crate::schema::parse_mysql_enum_type(&column_type);
                ColumnInfo {
                    name: r.get::<String, _>(0),
                    data_type: if enum_values.is_some() {
                        column_type
                    } else {
                        r.get::<String, _>(1)
                    },
                    nullable: r.get::<String, _>(3) == "YES",
                    default_value: r.try_get::<Option<String>, _>(4).ok().flatten(),
                    max_length: r.try_get::<Option<i64>, _>(5).ok().flatten(),
                    is_primary_key: r.get::<String, _>(6) == "PRI",
                    enum_values,
                }
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
                    // `NOT NON_UNIQUE` and `INDEX_NAME = 'PRIMARY'` are MySQL
                    // boolean expressions, which come back as BIGINT — reading
                    // them as i8 always errored and left both flags false.
                    is_unique: r.try_get::<i64, _>(2).map(|v| v != 0).unwrap_or(false),
                    is_primary: r.try_get::<i64, _>(3).map(|v| v != 0).unwrap_or(false),
                }
            })
            .collect();

        Ok((columns, indexes))
    }

    async fn list_foreign_keys(
        &self,
        schema: Option<&str>,
        table: &str,
    ) -> Result<Vec<ForeignKeyInfo>, CoreError> {
        // MySQL FKs: the table is a child (REFERENCED_TABLE_NAME = parent) or a
        // parent (TABLE_NAME = parent, so the FK appears on another row). Match
        // either by joining on the constraint name / referenced table.
        let schema = schema.unwrap_or(&self.database);
        let rows = sqlx::query(
            "SELECT k.CONSTRAINT_NAME, k.TABLE_SCHEMA, k.TABLE_NAME,
                    GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION) AS local_cols,
                    k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME,
                    NULL AS foreign_cols   -- filled below; MySQL KEY_COLUMN_USAGE gives referenced columns per local column
             FROM information_schema.KEY_COLUMN_USAGE k
             WHERE k.REFERENCED_TABLE_NAME IS NOT NULL
               AND k.TABLE_SCHEMA = ?
               AND (k.TABLE_NAME = ? OR k.REFERENCED_TABLE_NAME = ?)
             GROUP BY k.CONSTRAINT_NAME, k.TABLE_SCHEMA, k.TABLE_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME
             ORDER BY k.CONSTRAINT_NAME",
        )
        .bind(schema)
        .bind(table)
        .bind(table)
        .fetch_all(&self.pool)
        .await?;

        // MySQL KEY_COLUMN_USAGE lists each column pair; reconstruct
        // referenced columns per constraint without GROUP_CONCAT ordering bugs.
        let mut out: Vec<ForeignKeyInfo> = Vec::new();
        for r in &rows {
            let constraint_name: String = r.get(0);
            let local_schema: String = r.get(1);
            let local_table: String = r.get(2);
            let local_cols: Option<String> = r.get(3);
            let foreign_schema: String = r.get(4);
            let foreign_table: String = r.get(5);
            let local_cols: Vec<String> = local_cols
                .unwrap_or_default()
                .split(',')
                .map(|s| s.to_string())
                .collect();
            // Referenced columns for this constraint.
            let fk_rows = sqlx::query(
                "SELECT REFERENCED_COLUMN_NAME
                 FROM information_schema.KEY_COLUMN_USAGE
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?
                 ORDER BY ORDINAL_POSITION",
            )
            .bind(&local_schema)
            .bind(&local_table)
            .bind(&constraint_name)
            .fetch_all(&self.pool)
            .await?;
            let foreign_cols: Vec<String> = fk_rows
                .iter()
                .map(|f| f.get::<String, _>(0))
                .collect();
            out.push(ForeignKeyInfo {
                name: constraint_name,
                schema: local_schema,
                local_table,
                local_columns: local_cols,
                foreign_schema,
                foreign_table,
                foreign_columns: foreign_cols,
            });
        }
        // Dedupe: a self-referencing FK would appear via both matches.
        let mut seen = std::collections::HashSet::new();
        out.retain(|fk| seen.insert((fk.name.clone(), fk.local_table.clone())));
        Ok(out)
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
            let exec_result = run_execute!(&mut **txn_guard.as_mut().unwrap());
            let elapsed = start.elapsed();
            let mut qr = QueryResult::from_duration(elapsed);
            qr.affected_rows = Some(exec_result.rows_affected());
            qr
        } else {
            let exec_result = run_execute!(&self.pool);
            let elapsed = start.elapsed();
            let mut qr = QueryResult::from_duration(elapsed);
            qr.affected_rows = Some(exec_result.rows_affected());
            qr
        };

        drop(txn_guard);
        Ok(result)
    }

    async fn alter_table(
        &self,
        schema: Option<&str>,
        table: &str,
        request: &AlterRequest,
    ) -> Result<String, CoreError> {
        let sql = alter::build_alter_sql(ENGINE, schema, table, request)
            .map_err(CoreError::Query)?;
        self.execute_query(&sql).await?;
        Ok(sql)
    }

    async fn fetch_table_rows(
        &self,
        schema: Option<&str>,
        table: &str,
        page: &PageRequest,
        where_clause: Option<&str>,
    ) -> Result<QueryResult, CoreError> {
        validate_where_clause(where_clause.unwrap_or(""), &ENGINE)?;

        let db = schema.unwrap_or(&self.database);
        let qualified = format!(
            "{}.{}",
            quote_ident(&ENGINE, db),
            quote_ident(&ENGINE, table)
        );

        let base_where = where_clause.unwrap_or("").trim();
        let (where_sql, order_sql) = match &page.keyset {
            Some(ks) => {
                // Keyset (cursor) step — see pg.rs for the shared rationale.
                // Bound MUST be rendered via render_keyset_value/quote_literal
                // (guardrail #1); the column is quoted as an identifier.
                let kcol = quote_ident(&ENGINE, &ks.column);
                let op = if ks.ascending { ">" } else { "<" };
                let bound = render_keyset_value(&ENGINE, &ks.value);
                let w = if base_where.is_empty() {
                    format!("WHERE {kcol} {op} {bound}")
                } else {
                    format!("WHERE ({base_where}) AND {kcol} {op} {bound}")
                };
                let dir = if ks.ascending { "ASC" } else { "DESC" };
                (w, format!("ORDER BY {kcol} {dir}"))
            }
            None => {
                let w = if base_where.is_empty() {
                    String::new()
                } else {
                    format!("WHERE {base_where}")
                };
                let o = match &page.order_by {
                    Some(col) => {
                        let dir = if page.order_desc { "DESC" } else { "ASC" };
                        format!("ORDER BY {} {}", quote_ident(&ENGINE, col), dir)
                    }
                    None => String::new(),
                };
                (w, o)
            }
        };

        let sql = format!(
            "SELECT * FROM {} {} {} LIMIT {} OFFSET {}",
            qualified, where_sql, order_sql, page.limit, page.offset
        );

        let mut result = self.execute_query(&sql).await?;
        if result.columns.is_empty() {
            let (cols, _) = self.describe_table(Some(db), table).await?;
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

        let db = schema.unwrap_or(&self.database);
        let qualified = format!(
            "{}.{}",
            quote_ident(&ENGINE, db),
            quote_ident(&ENGINE, table)
        );
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
