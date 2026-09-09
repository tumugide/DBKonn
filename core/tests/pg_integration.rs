//! Integration tests for the Postgres driver.
//!
//! These tests are skipped at runtime if the Postgres connection env-vars are absent.
//! To run them:
//!
//!   TEST_PG_HOST=localhost TEST_PG_PORT=5432 TEST_PG_USER=postgres \
//!   TEST_PG_PASS=secret    TEST_PG_DB=postgres \
//!   cargo test -p dbkonn-core --test pg_integration

use dbkonn_core::{
    connection::{ConnectionConfig, DbEngine, SslMode},
    drivers::connect,
    query::{Keyset, PageRequest, RowValue},
};

fn pg_config() -> Option<ConnectionConfig> {
    let host = std::env::var("TEST_PG_HOST").unwrap_or_else(|_| "localhost".to_string());
    let port: u16 = std::env::var("TEST_PG_PORT")
        .unwrap_or_else(|_| "5432".to_string())
        .parse()
        .unwrap_or(5432);
    let user = std::env::var("TEST_PG_USER").unwrap_or_else(|_| "postgres".to_string());
    let pass = std::env::var("TEST_PG_PASS").ok();
    let db   = std::env::var("TEST_PG_DB").unwrap_or_else(|_| "postgres".to_string());

    // Only proceed if at least TEST_PG_HOST or TEST_PG_USER is explicitly set;
    // otherwise assume no local Postgres is available.
    if std::env::var("TEST_PG_HOST").is_err() && std::env::var("TEST_PG_USER").is_err() {
        return None;
    }

    Some(ConnectionConfig {
        id: "test-pg".to_string(),
        name: "Test Postgres".to_string(),
        engine: DbEngine::Postgres,
        host: Some(host),
        port: Some(port),
        username: Some(user),
        password: pass,
        database: Some(db),
        file_path: None,
        ssl_mode: SslMode::Prefer,
        tls: None,
        color: None,
    })
}

macro_rules! pg_or_skip {
    () => {
        match pg_config() {
            Some(c) => c,
            None => {
                eprintln!(
                    "⚠  Skipping Postgres test — set TEST_PG_HOST / TEST_PG_USER to enable"
                );
                return;
            }
        }
    };
}

// ── Cleanup helper ─────────────────────────────────────────────────────────────

async fn cleanup(driver: &dyn dbkonn_core::drivers::DbConnection) {
    let _ = driver.execute_query("DROP TABLE IF EXISTS dbkonn_type_test").await;
    let _ = driver.execute_query("DROP TABLE IF EXISTS dbkonn_page_test").await;
    let _ = driver.execute_query("DROP TABLE IF EXISTS dbkonn_filter_test").await;
    let _ = driver.execute_query("DROP TYPE  IF EXISTS dbkonn_status").await;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_pg_connect() {
    let config = pg_or_skip!();
    let driver = connect(&config).await.expect("connect failed");
    driver.test_connection().await.expect("ping failed");
}

#[tokio::test]
async fn test_pg_list_schemas() {
    let config = pg_or_skip!();
    let driver = connect(&config).await.unwrap();
    let schemas = driver.list_schemas().await.unwrap();
    assert!(
        schemas.iter().any(|s| s.name == "public"),
        "expected 'public' schema, got: {:?}", schemas
    );
}

#[tokio::test]
async fn test_pg_list_databases() {
    let config = pg_or_skip!();
    let driver = connect(&config).await.unwrap();
    let dbs = driver.list_databases().await.unwrap();
    assert!(!dbs.is_empty(), "should have at least one database");
}

#[tokio::test]
async fn test_pg_comprehensive_types() {
    let config = pg_or_skip!();
    let driver = connect(&config).await.unwrap();

    cleanup(driver.as_ref()).await;

    // Create an enum and a table with many Postgres-specific types
    driver.execute_query(
        "CREATE TYPE dbkonn_status AS ENUM ('active', 'inactive', 'pending')"
    ).await.unwrap();

    driver.execute_query("
        CREATE TABLE dbkonn_type_test (
            id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
            name        TEXT        NOT NULL,
            code        VARCHAR(10),
            score       NUMERIC(10,4),
            active      BOOLEAN,
            int_val     INTEGER,
            big_val     BIGINT,
            real_val    REAL,
            dbl_val     DOUBLE PRECISION,
            created_at  TIMESTAMPTZ DEFAULT NOW(),
            updated_at  TIMESTAMP   DEFAULT NOW(),
            birth_date  DATE        DEFAULT CURRENT_DATE,
            tags        TEXT[],
            meta        JSONB,
            status      dbkonn_status,
            raw_bytes   BYTEA
        )
    ").await.unwrap();

    driver.execute_query("
        INSERT INTO dbkonn_type_test
            (name, code, score, active, int_val, big_val, real_val, dbl_val,
             tags, meta, status, raw_bytes)
        VALUES (
            'Test Row',
            'ABC',
            123.4567,
            true,
            42,
            9999999999,
            3.14,
            2.718281828,
            ARRAY['alpha','beta','gamma'],
            '{\"key\":\"val\",\"n\":1}',
            'active',
            '\\xDEADBEEF'
        )
    ").await.unwrap();

    let result = driver.execute_query("SELECT * FROM dbkonn_type_test").await.unwrap();

    assert!(result.error.is_none(), "query error: {:?}", result.error);
    assert_eq!(result.row_count, 1);

    let row = &result.rows[0];
    let col_names: Vec<&str> = result.columns.iter().map(|c| c.name.as_str()).collect();

    // Helper closure: find value by column name
    let get = |name: &str| -> &RowValue {
        let i = col_names.iter().position(|c| *c == name).unwrap_or(0);
        &row[i]
    };

    // UUID → Text containing hyphens
    match get("id") {
        RowValue::Text(s) => assert!(s.contains('-'), "UUID should have hyphens: {}", s),
        RowValue::Null    => panic!("UUID id must not be null"),
        other             => panic!("UUID id unexpected: {:?}", other),
    }

    // TEXT
    assert!(matches!(get("name"), RowValue::Text(s) if s == "Test Row"),
        "name mismatch: {:?}", get("name"));

    // NUMERIC → Text preserving decimal digits
    match get("score") {
        RowValue::Text(s) => {
            let v: f64 = s.parse().expect("score should be numeric string");
            assert!((v - 123.4567).abs() < 0.001, "score value: {}", v);
        }
        other => panic!("score should be Text(numeric), got: {:?}", other),
    }

    // BOOLEAN
    assert!(matches!(get("active"), RowValue::Bool(true)), "active: {:?}", get("active"));

    // INTEGER
    assert!(matches!(get("int_val"), RowValue::Integer(42)), "int_val: {:?}", get("int_val"));

    // BIGINT
    assert!(matches!(get("big_val"), RowValue::Integer(9_999_999_999)), "big_val: {:?}", get("big_val"));

    // TIMESTAMPTZ → non-null
    assert!(!matches!(get("created_at"), RowValue::Null), "timestamp should not be null");

    // TEXT[] → Json array
    match get("tags") {
        RowValue::Json(v) => {
            let arr = v.as_array().expect("tags should be json array");
            assert_eq!(arr.len(), 3, "tags length");
        }
        other => panic!("tags should be Json, got: {:?}", other),
    }

    // JSONB
    match get("meta") {
        RowValue::Json(_) => {}
        other => panic!("meta should be Json, got: {:?}", other),
    }

    // ENUM
    match get("status") {
        RowValue::Text(s) => assert_eq!(s, "active", "enum value mismatch"),
        RowValue::Null    => panic!("enum status must not be null"),
        other             => panic!("enum status unexpected: {:?}", other),
    }

    // BYTEA
    match get("raw_bytes") {
        RowValue::Binary(s) => assert!(s.starts_with("0x"), "bytea: {}", s),
        other => panic!("bytea unexpected: {:?}", other),
    }

    cleanup(driver.as_ref()).await;
}

#[tokio::test]
async fn test_pg_pagination() {
    let config = pg_or_skip!();
    let driver = connect(&config).await.unwrap();

    let _ = driver.execute_query("DROP TABLE IF EXISTS dbkonn_page_test").await;
    driver.execute_query(
        "CREATE TABLE dbkonn_page_test (id SERIAL PRIMARY KEY, val TEXT)"
    ).await.unwrap();

    driver.execute_query(
        "INSERT INTO dbkonn_page_test (val) \
         SELECT 'item_' || gs FROM generate_series(1,20) gs"
    ).await.unwrap();

    let page = driver.fetch_table_rows(
        Some("public"), "dbkonn_page_test",
        &PageRequest { limit: 5, offset: 0, order_by: Some("id".to_string()), order_desc: false, keyset: None },
        None,
    ).await.unwrap();
    assert_eq!(page.row_count, 5);

    let count = driver.count_rows(Some("public"), "dbkonn_page_test", None).await.unwrap();
    assert_eq!(count, 20);

    let _ = driver.execute_query("DROP TABLE IF EXISTS dbkonn_page_test").await;
}

#[tokio::test]
async fn test_pg_filter() {
    let config = pg_or_skip!();
    let driver = connect(&config).await.unwrap();

    let _ = driver.execute_query("DROP TABLE IF EXISTS dbkonn_filter_test").await;
    driver.execute_query(
        "CREATE TABLE dbkonn_filter_test (id SERIAL, cat TEXT, val INT)"
    ).await.unwrap();
    driver.execute_query(
        "INSERT INTO dbkonn_filter_test (cat, val) VALUES ('A',10),('B',20),('A',30)"
    ).await.unwrap();

    let filtered = driver.fetch_table_rows(
        Some("public"), "dbkonn_filter_test",
        &PageRequest::default(),
        Some("cat = 'A'"),
    ).await.unwrap();
    assert_eq!(filtered.row_count, 2, "expected 2 A rows");

    let count_b = driver.count_rows(
        Some("public"), "dbkonn_filter_test", Some("cat = 'B'")
    ).await.unwrap();
    assert_eq!(count_b, 1);

    let _ = driver.execute_query("DROP TABLE IF EXISTS dbkonn_filter_test").await;
}

#[tokio::test]
async fn test_pg_describe_table() {
    let config = pg_or_skip!();
    let driver = connect(&config).await.unwrap();

    let _ = driver.execute_query("DROP TABLE IF EXISTS dbkonn_desc_test").await;
    driver.execute_query("
        CREATE TABLE dbkonn_desc_test (
            id   SERIAL PRIMARY KEY,
            name TEXT   NOT NULL,
            val  NUMERIC(10,2) DEFAULT 0
        )
    ").await.unwrap();

    let (cols, indexes) = driver.describe_table(Some("public"), "dbkonn_desc_test").await.unwrap();

    assert!(cols.iter().any(|c| c.name == "id" && c.is_primary_key), "id PK missing");
    assert!(cols.iter().any(|c| c.name == "name" && !c.nullable), "name NOT NULL missing");
    assert!(!indexes.is_empty(), "should have at least a PK index");

    let _ = driver.execute_query("DROP TABLE IF EXISTS dbkonn_desc_test").await;
}

#[tokio::test]
async fn test_pg_foreign_keys_bidirectional() {
    let config = pg_or_skip!();
    let driver = connect(&config).await.unwrap();

    let _ = driver
        .execute_query("DROP TABLE IF EXISTS dbkonn_fk_child CASCADE")
        .await;
    let _ = driver
        .execute_query("DROP TABLE IF EXISTS dbkonn_fk_parent CASCADE")
        .await;
    driver
        .execute_query(
            "CREATE TABLE dbkonn_fk_parent (
                id   INT PRIMARY KEY,
                code VARCHAR(20) UNIQUE,
                name TEXT
             )",
        )
        .await
        .unwrap();
    driver
        .execute_query(
            "CREATE TABLE dbkonn_fk_child (
                id       INT PRIMARY KEY,
                parent_id INT NOT NULL REFERENCES dbkonn_fk_parent(id),
                parent_code VARCHAR(20) REFERENCES dbkonn_fk_parent(code)
             )",
        )
        .await
        .unwrap();

    // Outgoing: queried on the child — both FKs point at the parent.
    let child_fks = driver
        .list_foreign_keys(Some("public"), "dbkonn_fk_child")
        .await
        .unwrap();
    assert_eq!(child_fks.len(), 2, "child should report 2 outgoing FKs");
    for fk in &child_fks {
        assert_eq!(fk.local_table, "dbkonn_fk_child");
        assert_eq!(fk.foreign_table, "dbkonn_fk_parent");
        assert_eq!(fk.foreign_schema, "public");
        assert_eq!(fk.local_columns.len(), fk.foreign_columns.len());
    }
    let by_local: std::collections::HashMap<&str, &dbkonn_core::query::ForeignKeyInfo> =
        child_fks
            .iter()
            .map(|f| (f.local_columns[0].as_str(), f))
            .collect();
    assert_eq!(
        by_local["parent_id"].foreign_columns[0], "id",
        "parent_id -> parent.id"
    );
    assert_eq!(
        by_local["parent_code"].foreign_columns[0], "code",
        "parent_code -> parent.code"
    );

    // Incoming: queried on the parent — both child FKs refer back here.
    let parent_fks = driver
        .list_foreign_keys(Some("public"), "dbkonn_fk_parent")
        .await
        .unwrap();
    assert_eq!(parent_fks.len(), 2, "parent should report 2 incoming FKs");
    for fk in &parent_fks {
        assert_eq!(fk.local_table, "dbkonn_fk_child", "child owns the FK");
        assert_eq!(fk.foreign_table, "dbkonn_fk_parent", "we are the parent");
    }

    let _ = driver
        .execute_query("DROP TABLE IF EXISTS dbkonn_fk_child CASCADE")
        .await;
    let _ = driver
        .execute_query("DROP TABLE IF EXISTS dbkonn_fk_parent CASCADE")
        .await;
}

#[tokio::test]
async fn test_pg_keyset_pagination() {
    let config = pg_or_skip!();
    let driver = connect(&config).await.unwrap();

    let _ = driver
        .execute_query("DROP TABLE IF EXISTS dbkonn_keyset_test CASCADE")
        .await;
    driver
        .execute_query("CREATE TABLE dbkonn_keyset_test (id INT PRIMARY KEY, payload TEXT)")
        .await
        .unwrap();
    driver
        .execute_query(
            "INSERT INTO dbkonn_keyset_test (id, payload)
             SELECT g, 'row-' || g FROM generate_series(1, 25) g",
        )
        .await
        .unwrap();

    // AS a baseline, page 1 (OFFSET 0) returns ids 1..10 ascending.
    let p1 = driver
        .fetch_table_rows(
            Some("public"),
            "dbkonn_keyset_test",
            &PageRequest {
                limit: 10,
                offset: 0,
                order_by: Some("id".to_string()),
                order_desc: false,
                keyset: None,
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(p1.row_count, 10);
    let ids: Vec<i64> = p1
        .rows
        .iter()
        .map(|r| match r[0] {
            RowValue::Integer(n) => n,
            _ => panic!("id column should be integer"),
        })
        .collect();
    assert_eq!(ids, (1..=10).collect::<Vec<i64>>());

    // Keyset forward step: WHERE id > 10 ORDER BY id LIMIT 10 → ids 11..20.
    let k2 = driver
        .fetch_table_rows(
            Some("public"),
            "dbkonn_keyset_test",
            &PageRequest {
                limit: 10,
                offset: 0,
                order_by: Some("id".to_string()),
                order_desc: false,
                keyset: Some(Keyset {
                    column: "id".to_string(),
                    value: RowValue::Integer(10),
                    ascending: true,
                }),
            },
            None,
        )
        .await
        .unwrap();
    let ids2: Vec<i64> = k2
        .rows
        .iter()
        .map(|r| match r[0] {
            RowValue::Integer(n) => n,
            _ => panic!("id column should be integer"),
        })
        .collect();
    assert_eq!(ids2, (11..=20).collect::<Vec<i64>>(), "keyset page 2");

    // One more step → ids 21..25 (short page = end of table).
    let k3 = driver
        .fetch_table_rows(
            Some("public"),
            "dbkonn_keyset_test",
            &PageRequest {
                limit: 10,
                offset: 0,
                order_by: Some("id".to_string()),
                order_desc: false,
                keyset: Some(Keyset {
                    column: "id".to_string(),
                    value: RowValue::Integer(20),
                    ascending: true,
                }),
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(k3.row_count, 5);
    assert!(matches!(k3.rows[0][0], RowValue::Integer(21)));

    // Descending keyset: first page 25..16, then WHERE id < 16 → 15..6.
    let d1 = driver
        .fetch_table_rows(
            Some("public"),
            "dbkonn_keyset_test",
            &PageRequest {
                limit: 10,
                offset: 0,
                order_by: Some("id".to_string()),
                order_desc: true,
                keyset: None,
            },
            None,
        )
        .await
        .unwrap();
    assert!(matches!(d1.rows[0][0], RowValue::Integer(25)));

    let d2 = driver
        .fetch_table_rows(
            Some("public"),
            "dbkonn_keyset_test",
            &PageRequest {
                limit: 10,
                offset: 0,
                order_by: Some("id".to_string()),
                order_desc: true,
                keyset: Some(Keyset {
                    column: "id".to_string(),
                    value: RowValue::Integer(16),
                    ascending: false,
                }),
            },
            None,
        )
        .await
        .unwrap();
    assert!(matches!(d2.rows[0][0], RowValue::Integer(15)), "desc keyset");

    // Keyset combined with a filter: WHERE payload LIKE 'row-1%' → the rows
    // 1, 10..19 (10 of them on the first page). Next step with id > 18 → 19.
    let f1 = driver
        .fetch_table_rows(
            Some("public"),
            "dbkonn_keyset_test",
            &PageRequest {
                limit: 10,
                offset: 0,
                order_by: Some("id".to_string()),
                order_desc: false,
                keyset: None,
            },
            Some("payload LIKE 'row-1%'"),
        )
        .await
        .unwrap();
    assert_eq!(f1.row_count, 10);
    assert!(matches!(f1.rows[0][0], RowValue::Integer(1)));
    assert!(matches!(f1.rows[9][0], RowValue::Integer(18)));
    let f2 = driver
        .fetch_table_rows(
            Some("public"),
            "dbkonn_keyset_test",
            &PageRequest {
                limit: 10,
                offset: 0,
                order_by: Some("id".to_string()),
                order_desc: false,
                keyset: Some(Keyset {
                    column: "id".to_string(),
                    value: RowValue::Integer(18),
                    ascending: true,
                }),
            },
            Some("payload LIKE 'row-1%'"),
        )
        .await
        .unwrap();
    assert_eq!(f2.row_count, 1, "only id 19 left after 18");
    assert!(matches!(f2.rows[0][0], RowValue::Integer(19)));

    let _ = driver
        .execute_query("DROP TABLE IF EXISTS dbkonn_keyset_test CASCADE")
        .await;
}
