//! Integration tests for the SQLite driver.
//! These tests run against an in-memory database — no external setup required.

use dbkonn_core::{
    connection::{ConnectionConfig, DbEngine, SslMode},
    drivers::connect,
    query::{PageRequest, RowValue},
    validator::validate_sql,
};

fn sqlite_config() -> ConnectionConfig {
    ConnectionConfig {
        id: "test-sqlite".to_string(),
        name: "Test SQLite".to_string(),
        engine: DbEngine::SQLite,
        host: None,
        port: None,
        username: None,
        password: None,
        database: None,
        file_path: Some(":memory:".to_string()),
        ssl_mode: SslMode::Disable,
    }
}

#[tokio::test]
async fn test_sqlite_connect_and_ping() {
    let driver = connect(&sqlite_config()).await.expect("connect failed");
    driver.test_connection().await.expect("ping failed");
}

#[tokio::test]
async fn test_sqlite_basic_query() {
    let driver = connect(&sqlite_config()).await.unwrap();

    driver
        .execute_query(
            "CREATE TABLE users (
                id      INTEGER PRIMARY KEY,
                name    TEXT    NOT NULL,
                score   REAL,
                active  INTEGER DEFAULT 1
            )",
        )
        .await
        .unwrap();

    driver
        .execute_query(
            "INSERT INTO users VALUES (1,'Alice',9.5,1),(2,'Bob',7.3,0)",
        )
        .await
        .unwrap();

    let result = driver
        .execute_query("SELECT * FROM users ORDER BY id")
        .await
        .unwrap();

    assert!(result.error.is_none(), "unexpected error: {:?}", result.error);
    assert_eq!(result.columns.len(), 4, "expected 4 columns");
    assert_eq!(result.row_count, 2, "expected 2 rows");
    assert!(result.execution_time_ms < 5_000);

    // Row 0 — Alice
    let row0 = &result.rows[0];
    assert!(matches!(row0[0], RowValue::Integer(1)), "id mismatch: {:?}", row0[0]);
    assert!(
        matches!(&row0[1], RowValue::Text(s) if s == "Alice"),
        "name mismatch: {:?}", row0[1]
    );
    assert!(matches!(row0[3], RowValue::Integer(1)), "active mismatch");

    // Row 1 — Bob: active = 0
    assert!(matches!(result.rows[1][3], RowValue::Integer(0)));
}

#[tokio::test]
async fn test_sqlite_null_handling() {
    let driver = connect(&sqlite_config()).await.unwrap();

    driver
        .execute_query("CREATE TABLE nullable_test (id INTEGER, val TEXT)")
        .await
        .unwrap();
    driver
        .execute_query("INSERT INTO nullable_test VALUES (1, NULL), (2, 'present')")
        .await
        .unwrap();

    let result = driver
        .execute_query("SELECT * FROM nullable_test ORDER BY id")
        .await
        .unwrap();

    assert_eq!(result.row_count, 2);
    // First row's val must be NULL
    assert!(
        matches!(result.rows[0][1], RowValue::Null),
        "expected Null, got {:?}", result.rows[0][1]
    );
    // Second row's val must be Text
    assert!(
        matches!(&result.rows[1][1], RowValue::Text(s) if s == "present"),
        "expected Text('present'), got {:?}", result.rows[1][1]
    );
}

#[tokio::test]
async fn test_sqlite_blob_handling() {
    let driver = connect(&sqlite_config()).await.unwrap();

    driver
        .execute_query("CREATE TABLE blob_test (id INTEGER, data BLOB)")
        .await
        .unwrap();
    driver
        .execute_query("INSERT INTO blob_test VALUES (1, X'deadbeef0102030405')")
        .await
        .unwrap();

    let result = driver
        .execute_query("SELECT * FROM blob_test")
        .await
        .unwrap();

    match &result.rows[0][1] {
        RowValue::Binary(hex) => {
            assert!(hex.starts_with("0x"), "should start with 0x: {}", hex);
        }
        other => panic!("expected Binary, got {:?}", other),
    }
}

#[tokio::test]
async fn test_sqlite_list_tables() {
    let driver = connect(&sqlite_config()).await.unwrap();

    driver.execute_query("CREATE TABLE alpha (id INTEGER)").await.unwrap();
    driver.execute_query("CREATE TABLE beta  (id INTEGER)").await.unwrap();
    driver
        .execute_query("CREATE VIEW gamma AS SELECT id FROM alpha")
        .await
        .unwrap();

    let tables = driver.list_tables(None).await.unwrap();
    let names: Vec<_> = tables.iter().map(|t| t.name.as_str()).collect();
    assert!(names.contains(&"alpha"), "missing alpha: {:?}", names);
    assert!(names.contains(&"beta"),  "missing beta: {:?}",  names);
    assert!(names.contains(&"gamma"), "missing gamma: {:?}", names);
}

#[tokio::test]
async fn test_sqlite_describe_table() {
    let driver = connect(&sqlite_config()).await.unwrap();

    driver
        .execute_query(
            "CREATE TABLE described (
                id    INTEGER PRIMARY KEY,
                name  TEXT    NOT NULL,
                score REAL    DEFAULT 0.0,
                data  BLOB
            )",
        )
        .await
        .unwrap();

    let (cols, _indexes) = driver.describe_table(None, "described").await.unwrap();

    assert_eq!(cols.len(), 4);
    assert_eq!(cols[0].name, "id");
    assert!(cols[0].is_primary_key, "id should be PK");
    assert_eq!(cols[1].name, "name");
    assert!(!cols[1].nullable, "name should be NOT NULL");
    assert_eq!(cols[2].name, "score");
    assert_eq!(cols[3].name, "data");
}

#[tokio::test]
async fn test_sqlite_pagination() {
    let driver = connect(&sqlite_config()).await.unwrap();

    driver
        .execute_query("CREATE TABLE pager (id INTEGER PRIMARY KEY)")
        .await
        .unwrap();

    for i in 1i64..=10 {
        driver
            .execute_query(&format!("INSERT INTO pager VALUES ({})", i))
            .await
            .unwrap();
    }

    // Page 1: rows 1-3
    let p1 = driver
        .fetch_table_rows(
            None,
            "pager",
            &PageRequest {
                limit: 3,
                offset: 0,
                order_by: Some("id".to_string()),
                order_desc: false,
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(p1.row_count, 3);
    assert!(matches!(p1.rows[0][0], RowValue::Integer(1)));

    // Page 2: rows 4-6
    let p2 = driver
        .fetch_table_rows(
            None,
            "pager",
            &PageRequest {
                limit: 3,
                offset: 3,
                order_by: Some("id".to_string()),
                order_desc: false,
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(p2.row_count, 3);
    assert!(matches!(p2.rows[0][0], RowValue::Integer(4)));

    // Count
    let count = driver.count_rows(None, "pager", None).await.unwrap();
    assert_eq!(count, 10);
}

#[tokio::test]
async fn test_sqlite_filter_where_clause() {
    let driver = connect(&sqlite_config()).await.unwrap();

    driver
        .execute_query("CREATE TABLE items (id INTEGER, cat TEXT, val REAL)")
        .await
        .unwrap();
    driver
        .execute_query("INSERT INTO items VALUES (1,'A',10.0),(2,'B',20.0),(3,'A',30.0)")
        .await
        .unwrap();

    let filtered = driver
        .fetch_table_rows(None, "items", &PageRequest::default(), Some("cat = 'A'"))
        .await
        .unwrap();
    assert_eq!(filtered.row_count, 2, "expected 2 A rows");

    let count_b = driver
        .count_rows(None, "items", Some("cat = 'B'"))
        .await
        .unwrap();
    assert_eq!(count_b, 1);
}

#[tokio::test]
async fn test_sqlite_descending_sort() {
    let driver = connect(&sqlite_config()).await.unwrap();

    driver.execute_query("CREATE TABLE sorted (n INTEGER)").await.unwrap();
    driver.execute_query("INSERT INTO sorted VALUES (3),(1),(4),(1),(5)").await.unwrap();

    let result = driver
        .fetch_table_rows(
            None,
            "sorted",
            &PageRequest {
                limit: 100,
                offset: 0,
                order_by: Some("n".to_string()),
                order_desc: true,
            },
            None,
        )
        .await
        .unwrap();

    // First row must be 5 (highest)
    assert!(matches!(result.rows[0][0], RowValue::Integer(5)), "first should be 5");
}

#[tokio::test]
async fn test_sqlite_affected_rows() {
    let driver = connect(&sqlite_config()).await.unwrap();

    driver.execute_query("CREATE TABLE affected (id INTEGER)").await.unwrap();
    driver.execute_query("INSERT INTO affected VALUES (1),(2),(3)").await.unwrap();

    let result = driver
        .execute_query("DELETE FROM affected WHERE id > 1")
        .await
        .unwrap();

    assert!(result.error.is_none());
    assert_eq!(result.affected_rows, Some(2), "should delete 2 rows");
}

#[tokio::test]
async fn test_sql_validator_sqlite() {
    // Valid SQL
    assert!(
        validate_sql("SELECT * FROM users WHERE id = 1", &DbEngine::SQLite).is_ok()
    );
    assert!(
        validate_sql("INSERT INTO t (a,b) VALUES (1,'x')", &DbEngine::SQLite).is_ok()
    );
    assert!(
        validate_sql("UPDATE t SET a = 2 WHERE b = 'x'", &DbEngine::SQLite).is_ok()
    );

    // Invalid SQL
    assert!(
        validate_sql("SELECT * FRM users", &DbEngine::SQLite).is_err(),
        "FRM should be invalid"
    );
    assert!(
        validate_sql("SELCT 1", &DbEngine::SQLite).is_err(),
        "SELCT should be invalid"
    );
}

#[tokio::test]
async fn test_sql_validator_postgres_dialect() {
    // Postgres-specific syntax
    assert!(
        validate_sql("SELECT id::text FROM t", &DbEngine::Postgres).is_ok()
    );
    assert!(
        validate_sql("SELECT * FROM t LIMIT 10 OFFSET 5", &DbEngine::Postgres).is_ok()
    );
}
