use std::time::Instant;

use async_trait::async_trait;
use sqlx::{postgres::PgPoolOptions, Column, PgPool, Row, TypeInfo, ValueRef};

use crate::{
    connection::ConnectionConfig,
    error::CoreError,
    query::{ColumnInfo, IndexInfo, PageRequest, QueryResult, RowValue, SchemaInfo, TableInfo},
};

use super::DbConnection;

pub struct PgDriver {
    pool: PgPool,
}

impl PgDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self, CoreError> {
        let url = config.connection_url();
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(&url)
            .await
            .map_err(|e| CoreError::Connection(e.to_string()))?;
        Ok(Self { pool })
    }
}

/// Decode a single cell from a Postgres row into a JSON-serializable RowValue.
/// Handles all common Postgres types including UUID, enums, arrays, numerics, etc.
fn pg_value_to_row_value(row: &sqlx::postgres::PgRow, idx: usize) -> RowValue {
    // Null check via raw reference
    match row.try_get_raw(idx) {
        Ok(raw) if raw.is_null() => return RowValue::Null,
        Err(_) => return RowValue::Null,
        _ => {}
    }

    let col = row.column(idx);
    let type_name = col.type_info().name().to_lowercase();

    match type_name.as_str() {
        // ── Boolean ─────────────────────────────────────────────────────────
        "bool" => row
            .try_get::<bool, _>(idx)
            .map(RowValue::Bool)
            .unwrap_or(RowValue::Null),

        // ── Integers — widths must match binary protocol ────────────────────
        "int2" | "smallint" | "smallserial" => row
            .try_get::<i16, _>(idx)
            .map(|v| RowValue::Integer(v as i64))
            .unwrap_or(RowValue::Null),

        "int4" | "integer" | "int" | "serial" => row
            .try_get::<i32, _>(idx)
            .map(|v| RowValue::Integer(v as i64))
            .unwrap_or(RowValue::Null),

        "int8" | "bigint" | "bigserial" => row
            .try_get::<i64, _>(idx)
            .map(RowValue::Integer)
            .unwrap_or(RowValue::Null),

        "oid" => row
            .try_get_unchecked::<i32, _>(idx)
            .map(|v| RowValue::Integer((v as u32) as i64))
            .unwrap_or(RowValue::Null),

        // ── Floats ──────────────────────────────────────────────────────────
        "float4" | "real" => row
            .try_get::<f32, _>(idx)
            .map(|v| RowValue::Float(v as f64))
            .unwrap_or(RowValue::Null),

        "float8" | "double precision" => row
            .try_get::<f64, _>(idx)
            .map(RowValue::Float)
            .unwrap_or(RowValue::Null),

        // ── Arbitrary-precision numeric ──────────────────────────────────────
        "numeric" | "decimal" | "money" => row
            .try_get::<rust_decimal::Decimal, _>(idx)
            .map(|d| RowValue::Text(d.to_string()))
            .unwrap_or_else(|_| {
                // Fallback: try f64 (loses precision but always works)
                row.try_get::<f64, _>(idx)
                    .map(RowValue::Float)
                    .unwrap_or(RowValue::Null)
            }),

        // ── Text variants ───────────────────────────────────────────────────
        "text" | "varchar" | "character varying" | "char" | "bpchar"
        | "name" | "citext" | "ltree" | "lquery" | "xml" | "xml[]" => row
            .try_get::<String, _>(idx)
            .map(RowValue::Text)
            .unwrap_or(RowValue::Null),

        // ── UUID ────────────────────────────────────────────────────────────
        "uuid" => row
            .try_get::<uuid::Uuid, _>(idx)
            .map(|u| RowValue::Text(u.to_string()))
            .unwrap_or(RowValue::Null),

        // ── JSON / JSONB ─────────────────────────────────────────────────────
        "json" | "jsonb" => row
            .try_get::<serde_json::Value, _>(idx)
            .map(RowValue::Json)
            .unwrap_or_else(|_| {
                row.try_get::<String, _>(idx)
                    .map(RowValue::Text)
                    .unwrap_or(RowValue::Null)
            }),

        // ── Binary / bytea ──────────────────────────────────────────────────
        "bytea" => row
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

        // ── Timestamps ───────────────────────────────────────────────────────
        "timestamp" | "timestamp without time zone" => row
            .try_get::<chrono::NaiveDateTime, _>(idx)
            .map(|dt| RowValue::Text(dt.format("%Y-%m-%d %H:%M:%S%.6f").to_string()))
            .unwrap_or(RowValue::Null),

        "timestamptz" | "timestamp with time zone" => row
            .try_get::<chrono::DateTime<chrono::Utc>, _>(idx)
            .map(|dt| RowValue::Text(dt.to_rfc3339()))
            .unwrap_or(RowValue::Null),

        // ── Date / Time ───────────────────────────────────────────────────────
        "date" => row
            .try_get::<chrono::NaiveDate, _>(idx)
            .map(|d| RowValue::Text(d.to_string()))
            .unwrap_or(RowValue::Null),

        "time" | "time without time zone" => row
            .try_get::<chrono::NaiveTime, _>(idx)
            .map(|t| RowValue::Text(t.to_string()))
            .unwrap_or(RowValue::Null),

        // timetz and interval: binary format is text-compatible, use unchecked
        "timetz" | "time with time zone" | "interval" => row
            .try_get_unchecked::<String, _>(idx)
            .map(RowValue::Text)
            .unwrap_or(RowValue::Null),

        // ── Arrays (type names begin with _ in Postgres internals) ────────────
        // Use try_get_unchecked to bypass OID compatibility check; the binary
        // array decoder works regardless of whether the type OID was looked up.
        t if t.starts_with('_') => decode_pg_array(row, idx, t),

        // ── Enum types, custom types, and unknown OIDs ────────────────────────
        // Enum binary protocol sends the label as plain UTF-8 bytes → works.
        // For arrays whose type name wasn't resolved to the _ prefix convention
        // (sqlx may return an empty name for some OIDs), detect them by the
        // Postgres binary array header: always starts with \x00\x00\x00 (ndim bytes).
        _ => {
            match row.try_get_unchecked::<String, _>(idx) {
                // Valid non-array text (enum values, custom types, etc.)
                Ok(s) if !s.starts_with('\0') => RowValue::Text(s),
                // Starts with null bytes → likely a binary-encoded array with
                // an unresolved type name; retry as Vec decode.
                _ => decode_pg_array(row, idx, &type_name),
            }
        }
    }
}

/// Decode a Postgres array column into a JSON array RowValue.
/// Uses try_get_unchecked to bypass OID compatibility checks.
fn decode_pg_array(row: &sqlx::postgres::PgRow, idx: usize, type_name: &str) -> RowValue {
    // String arrays (TEXT[], VARCHAR[], enum arrays, UUID arrays, etc.)
    if let Ok(v) = row.try_get_unchecked::<Vec<String>, _>(idx) {
        return RowValue::Json(serde_json::json!(v));
    }
    // Integer arrays
    if let Ok(v) = row.try_get_unchecked::<Vec<i64>, _>(idx) {
        return RowValue::Json(serde_json::json!(v));
    }
    if let Ok(v) = row.try_get_unchecked::<Vec<i32>, _>(idx) {
        return RowValue::Json(serde_json::json!(v));
    }
    // Float arrays
    if let Ok(v) = row.try_get_unchecked::<Vec<f64>, _>(idx) {
        return RowValue::Json(serde_json::json!(v));
    }
    // Boolean arrays
    if let Ok(v) = row.try_get_unchecked::<Vec<bool>, _>(idx) {
        return RowValue::Json(serde_json::json!(v));
    }
    // UUID arrays → decode as strings
    if let Ok(v) = row.try_get_unchecked::<Vec<uuid::Uuid>, _>(idx) {
        let strs: Vec<String> = v.iter().map(|u| u.to_string()).collect();
        return RowValue::Json(serde_json::json!(strs));
    }
    // Fallback: show type placeholder
    let elem_type = type_name.strip_prefix('_').unwrap_or(type_name);
    RowValue::Text(format!("[array<{}>]", elem_type))
}

fn rows_to_query_result(
    rows: Vec<sqlx::postgres::PgRow>,
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
                .map(|idx| pg_value_to_row_value(row, idx))
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
impl DbConnection for PgDriver {
    async fn test_connection(&self) -> Result<(), CoreError> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .map_err(|e| CoreError::Connection(e.to_string()))?;
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<String>, CoreError> {
        let rows = sqlx::query(
            "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(|r| r.get::<String, _>(0)).collect())
    }

    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, CoreError> {
        let rows = sqlx::query(
            "SELECT schema_name FROM information_schema.schemata \
             WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast') \
             ORDER BY schema_name",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .iter()
            .map(|r| SchemaInfo {
                name: r.get::<String, _>(0),
            })
            .collect())
    }

    async fn list_tables(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, CoreError> {
        let schema = schema.unwrap_or("public");
        let rows = sqlx::query(
            "SELECT table_schema, table_name, table_type \
             FROM information_schema.tables \
             WHERE table_schema = $1 \
             ORDER BY table_name",
        )
        .bind(schema)
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
        let schema = schema.unwrap_or("public");

        let col_rows = sqlx::query(
            "SELECT
                c.column_name,
                c.data_type,
                c.is_nullable,
                c.column_default,
                c.character_maximum_length,
                COALESCE(
                  (SELECT true FROM information_schema.table_constraints tc
                   JOIN information_schema.key_column_usage kcu
                     ON tc.constraint_name = kcu.constraint_name
                     AND tc.table_schema = kcu.table_schema
                   WHERE tc.constraint_type = 'PRIMARY KEY'
                     AND kcu.table_schema = c.table_schema
                     AND kcu.table_name = c.table_name
                     AND kcu.column_name = c.column_name
                   LIMIT 1), false
                ) AS is_pk
             FROM information_schema.columns c
             WHERE c.table_schema = $1 AND c.table_name = $2
             ORDER BY c.ordinal_position",
        )
        .bind(schema)
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
                is_primary_key: r.get::<bool, _>(5),
            })
            .collect();

        let idx_rows = sqlx::query(
            "SELECT
                i.relname AS index_name,
                array_agg(a.attname ORDER BY x.ordinality) AS columns,
                ix.indisunique,
                ix.indisprimary
             FROM pg_class t
             JOIN pg_index ix ON t.oid = ix.indrelid
             JOIN pg_class i ON i.oid = ix.indexrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
             JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS x(attnum, ordinality) ON true
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum
             WHERE n.nspname = $1 AND t.relname = $2
             GROUP BY i.relname, ix.indisunique, ix.indisprimary
             ORDER BY i.relname",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&self.pool)
        .await?;

        let indexes: Vec<IndexInfo> = idx_rows
            .iter()
            .map(|r| {
                let cols: Vec<String> = r.try_get::<Vec<String>, _>(1).unwrap_or_default();
                IndexInfo {
                    name: r.get::<String, _>(0),
                    columns: cols,
                    is_unique: r.get::<bool, _>(2),
                    is_primary: r.get::<bool, _>(3),
                }
            })
            .collect();

        Ok((columns, indexes))
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult, CoreError> {
        let start = Instant::now();
        let sql_lower = sql.trim().to_lowercase();

        let is_fetch = sql_lower.starts_with("select")
            || sql_lower.starts_with("explain")
            || sql_lower.starts_with("show")
            || sql_lower.starts_with("with")
            || sql_lower.starts_with("table");

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
        let schema = schema.unwrap_or("public");
        let qualified = format!("\"{}\".\"{}\"", schema, table);

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
        let schema = schema.unwrap_or("public");
        let qualified = format!("\"{}\".\"{}\"", schema, table);
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
