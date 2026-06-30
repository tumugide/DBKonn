use serde::{Deserialize, Serialize};
use std::time::Duration;

/// A single cell value in a query result, JSON-serializable.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
