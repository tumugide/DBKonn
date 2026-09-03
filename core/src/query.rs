use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Largest integer magnitude a JS `number` (IEEE-754 double) can hold without
/// losing precision — `Number.MAX_SAFE_INTEGER`. `i64` values outside this
/// range are serialized as strings so the webview shows/edits the true value
/// instead of a silently rounded one (BIGINT columns, Postgres `oid`, etc.).
const JS_MAX_SAFE_INT: i64 = 9_007_199_254_740_991;

/// A single cell value in a query result, JSON-serializable.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum RowValue {
    Null,
    Bool(bool),
    Integer(i64),
    Float(f64),
    Text(String),
    /// JSON / JSONB stored as a raw JSON value
    Json(serde_json::Value),
    /// Binary data shown as a truncated hex string
    Binary(String),
}

impl Serialize for RowValue {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            RowValue::Null => serializer.serialize_none(),
            RowValue::Bool(b) => serializer.serialize_bool(*b),
            RowValue::Integer(i) => {
                if *i > JS_MAX_SAFE_INT || *i < -JS_MAX_SAFE_INT {
                    serializer.serialize_str(&i.to_string())
                } else {
                    serializer.serialize_i64(*i)
                }
            }
            RowValue::Float(f) => serializer.serialize_f64(*f),
            RowValue::Text(s) => serializer.serialize_str(s),
            RowValue::Json(v) => v.serialize(serializer),
            RowValue::Binary(s) => serializer.serialize_str(s),
        }
    }
}

impl std::fmt::Display for RowValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RowValue::Null => write!(f, "NULL"),
            RowValue::Bool(b) => write!(f, "{}", b),
            RowValue::Integer(i) => write!(f, "{}", i),
            RowValue::Float(fl) => write!(f, "{}", fl),
            RowValue::Text(s) => write!(f, "{}", s),
            RowValue::Json(v) => write!(f, "{}", v),
            RowValue::Binary(s) => write!(f, "{}", s),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
    pub default_value: Option<String>,
    pub max_length: Option<i64>,
    /// Allowed values when the column is an enum type.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub is_unique: bool,
    pub is_primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
    pub table_type: String, // "table", "view", etc.
    pub row_count_estimate: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaInfo {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<RowValue>>,
    pub row_count: usize,
    pub execution_time_ms: u64,
    pub error: Option<String>,
    pub affected_rows: Option<u64>,
}

impl QueryResult {
    pub fn empty() -> Self {
        Self {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            execution_time_ms: 0,
            error: None,
            affected_rows: None,
        }
    }

    pub fn with_error(msg: String, elapsed: Duration) -> Self {
        Self {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            execution_time_ms: elapsed.as_millis() as u64,
            error: Some(msg),
            affected_rows: None,
        }
    }

    pub fn from_duration(elapsed: Duration) -> Self {
        Self {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            execution_time_ms: elapsed.as_millis() as u64,
            error: None,
            affected_rows: None,
        }
    }
}

/// Best-effort check for whether a SQL statement produces a result set, used
/// by every driver's `execute_query` to route between "fetch rows" and
/// "execute and report affected count".
///
/// The old check was a bare `trim().starts_with("select")`-style prefix test,
/// which silently discarded returned rows for:
///   * `INSERT/UPDATE/DELETE ... RETURNING` (Postgres, SQLite)
///   * statements with a leading `--` or `/* */` comment
///   * `CALL proc()` / `EXEC proc` that select
///   * `VALUES (...)`, `TABLE foo`
///
/// This strips leading comments/whitespace first, then inspects the leading
/// keyword, treating data-modifying statements as row-returning only when they
/// contain a `RETURNING` clause.
pub fn statement_returns_rows(sql: &str) -> bool {
    let stripped = strip_leading_sql_noise(sql);
    let lower = stripped.to_ascii_lowercase();
    let leading: String = lower
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();

    match leading.as_str() {
        "select" | "with" | "show" | "explain" | "describe" | "desc" | "pragma" | "table"
        | "values" | "call" | "exec" | "execute" | "analyze" => true,
        "insert" | "update" | "delete" | "merge" => contains_returning_keyword(&lower),
        _ => false,
    }
}

/// Trim leading whitespace and SQL line (`-- …`) / block (`/* … */`) comments
/// from the front of a statement.
fn strip_leading_sql_noise(sql: &str) -> &str {
    let mut s = sql.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("--") {
            s = match rest.find('\n') {
                Some(nl) => rest[nl + 1..].trim_start(),
                None => "",
            };
        } else if let Some(rest) = s.strip_prefix("/*") {
            s = match rest.find("*/") {
                Some(end) => rest[end + 2..].trim_start(),
                None => "",
            };
        } else {
            return s;
        }
    }
}

/// Whether a lowercased statement has a `returning` clause outside of any
/// string/identifier literal. Good enough to catch real `RETURNING` clauses
/// without being fooled by the word appearing inside a quoted value.
fn contains_returning_keyword(lower: &str) -> bool {
    let bytes = lower.as_bytes();
    let mut in_single = false;
    let mut in_double = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        match c {
            b'\'' if !in_double => in_single = !in_single,
            b'"' if !in_single => in_double = !in_double,
            _ if !in_single && !in_double => {
                if lower[i..].starts_with("returning")
                    && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric() && bytes[i - 1] != b'_')
                {
                    let after = i + "returning".len();
                    if after >= bytes.len()
                        || (!bytes[after].is_ascii_alphanumeric() && bytes[after] != b'_')
                    {
                        return true;
                    }
                }
            }
            _ => {}
        }
        i += 1;
    }
    false
}

/// Pagination parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageRequest {
    pub limit: u64,
    pub offset: u64,
    pub order_by: Option<String>,
    pub order_desc: bool,
}

impl Default for PageRequest {
    fn default() -> Self {
        Self {
            limit: 100,
            offset: 0,
            order_by: None,
            order_desc: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn big_integers_serialize_as_strings() {
        // In range → JSON number.
        assert_eq!(
            serde_json::to_string(&RowValue::Integer(42)).unwrap(),
            "42"
        );
        // Out of JS safe range → JSON string, so no precision is lost.
        let big = 9_223_372_036_854_775_807_i64; // i64::MAX
        assert_eq!(
            serde_json::to_string(&RowValue::Integer(big)).unwrap(),
            format!("\"{big}\"")
        );
        assert_eq!(
            serde_json::to_string(&RowValue::Integer(-i64::MAX)).unwrap(),
            format!("\"{}\"", -i64::MAX)
        );
    }

    #[test]
    fn classifies_row_returning_statements() {
        assert!(statement_returns_rows("SELECT * FROM t"));
        assert!(statement_returns_rows("  \n\t select 1"));
        assert!(statement_returns_rows("-- a comment\nSELECT 1"));
        assert!(statement_returns_rows("/* block */ WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(statement_returns_rows("CALL my_proc()"));
        assert!(statement_returns_rows("VALUES (1), (2)"));
        assert!(statement_returns_rows(
            "INSERT INTO t (a) VALUES (1) RETURNING id"
        ));
        assert!(statement_returns_rows(
            "delete from t where a = 1 returning *"
        ));
    }

    #[test]
    fn classifies_non_row_returning_statements() {
        assert!(!statement_returns_rows("INSERT INTO t (a) VALUES (1)"));
        assert!(!statement_returns_rows("UPDATE t SET a = 1 WHERE id = 2"));
        assert!(!statement_returns_rows("DELETE FROM t"));
        assert!(!statement_returns_rows("CREATE TABLE t (id int)"));
        // "returning" only inside a string literal is not a RETURNING clause.
        assert!(!statement_returns_rows(
            "UPDATE t SET note = 'returning soon' WHERE id = 1"
        ));
    }
}
