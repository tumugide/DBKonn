use std::sync::Arc;

use dbkonn_core::{
    connection::ConnectionConfig,
    drivers::{self, DbConnection},
    query::{ColumnInfo, IndexInfo, PageRequest, QueryResult, SchemaInfo, TableInfo},
    validator,
};
use tauri::State;

use crate::{
    connections as conn_store,
    state::AppState,
};

/// Clone the live driver handle for `conn_id` out of the connection map under
/// a brief read lock, then release the lock. The caller runs the actual query
/// on the returned `Arc` with no lock held — see `AppState::connections`.
async fn driver_for(
    state: &State<'_, AppState>,
    conn_id: &str,
) -> Result<Arc<dyn DbConnection>, String> {
    let conns = state.connections.read().await;
    conns
        .get(conn_id)
        .cloned()
        .ok_or_else(|| "Connection not found".to_string())
}

// ── Connection lifecycle ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn connect_db(
    state: State<'_, AppState>,
    mut config: ConnectionConfig,
) -> Result<String, String> {
    // Inject password from Keychain if not provided
    if config.password.is_none() {
        config.password = conn_store::get_password_async(&config.id).await?;
    }

    let conn_id = config.id.clone();

    let driver: Arc<dyn DbConnection> = drivers::connect(&config)
        .await
        .map_err(|e| e.to_string())?
        .into();

    // Swap the new driver in under a short write lock; close any driver it
    // replaced (same id reconnecting) afterwards, off-lock.
    let previous = {
        let mut conns = state.connections.write().await;
        conns.insert(conn_id.clone(), driver)
    };
    if let Some(old) = previous {
        old.close().await;
    }

    Ok(conn_id)
}

#[tauri::command]
pub async fn disconnect_db(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<(), String> {
    let removed = {
        let mut conns = state.connections.write().await;
        conns.remove(&conn_id)
    };
    if let Some(driver) = removed {
        // Close the pool so server-side connections are dropped now, not
        // whenever the last Arc clone (a query still in flight) goes away.
        driver.close().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn test_connection(mut config: ConnectionConfig) -> Result<bool, String> {
    // For test-connection, use whatever password is passed (transient, not saved)
    if config.password.is_none() {
        config.password = conn_store::get_password_async(&config.id).await?;
    }
    let driver = drivers::connect(&config)
        .await
        .map_err(|e| e.to_string())?;
    let result = driver.test_connection().await.map_err(|e| e.to_string());
    // This is a throwaway connection — don't leave its pool open.
    driver.close().await;
    result?;
    Ok(true)
}

// ── Schema discovery ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_databases(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<String>, String> {
    let driver = driver_for(&state, &conn_id).await?;
    driver.list_databases().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_database(
    state: State<'_, AppState>,
    conn_id: String,
    name: String,
) -> Result<(), String> {
    let driver = driver_for(&state, &conn_id).await?;
    driver.create_database(&name).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_schemas(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<SchemaInfo>, String> {
    let driver = driver_for(&state, &conn_id).await?;
    driver.list_schemas().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_tables(
    state: State<'_, AppState>,
    conn_id: String,
    schema: Option<String>,
) -> Result<Vec<TableInfo>, String> {
    let driver = driver_for(&state, &conn_id).await?;
    driver
        .list_tables(schema.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn describe_table(
    state: State<'_, AppState>,
    conn_id: String,
    schema: Option<String>,
    table: String,
) -> Result<(Vec<ColumnInfo>, Vec<IndexInfo>), String> {
    let driver = driver_for(&state, &conn_id).await?;
    driver
        .describe_table(schema.as_deref(), &table)
        .await
        .map_err(|e| e.to_string())
}

// ── Query execution ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn execute_query(
    state: State<'_, AppState>,
    conn_id: String,
    sql: String,
) -> Result<QueryResult, String> {
    let driver = driver_for(&state, &conn_id).await?;
    driver.execute_query(&sql).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fetch_table_rows(
    state: State<'_, AppState>,
    conn_id: String,
    schema: Option<String>,
    table: String,
    page: PageRequest,
    where_clause: Option<String>,
) -> Result<QueryResult, String> {
    let driver = driver_for(&state, &conn_id).await?;
    driver
        .fetch_table_rows(schema.as_deref(), &table, &page, where_clause.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn count_rows(
    state: State<'_, AppState>,
    conn_id: String,
    schema: Option<String>,
    table: String,
    where_clause: Option<String>,
) -> Result<i64, String> {
    let driver = driver_for(&state, &conn_id).await?;
    driver
        .count_rows(schema.as_deref(), &table, where_clause.as_deref())
        .await
        .map_err(|e| e.to_string())
}

// ── SQL validation ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn validate_sql(
    config: ConnectionConfig,
    sql: String,
) -> Result<Option<validator::ParseError>, String> {
    match validator::validate_sql(&sql, &config.engine) {
        Ok(()) => Ok(None),
        Err(e) => Ok(Some(e)),
    }
}

// ── Connection management ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn parse_connection_url(url: String) -> Result<ConnectionConfig, String> {
    ConnectionConfig::from_url(&url).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_connection(mut config: ConnectionConfig) -> Result<String, String> {
    // Extract and store password in Keychain, strip from on-disk config
    if let Some(pw) = config.password.take() {
        conn_store::store_password(&config.id, &pw).map_err(|e| e.to_string())?;
    }

    let mut conns = conn_store::load_connections()?;
    // Upsert: replace existing with same id
    if let Some(pos) = conns.iter().position(|c| c.id == config.id) {
        conns[pos] = config.clone();
    } else {
        conns.push(config.clone());
    }
    conn_store::save_connections(&conns)?;

    Ok(config.id)
}

#[tauri::command]
pub async fn load_connections() -> Result<Vec<ConnectionConfig>, String> {
    conn_store::load_connections()
}

#[tauri::command]
pub async fn delete_connection(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<(), String> {
    // Remove active connection if open, closing its pool off-lock.
    let removed = {
        let mut conns = state.connections.write().await;
        conns.remove(&conn_id)
    };
    if let Some(driver) = removed {
        driver.close().await;
    }

    // Remove from Keychain
    conn_store::delete_password(&conn_id);

    // Remove from disk
    let mut conns = conn_store::load_connections()?;
    conns.retain(|c| c.id != conn_id);
    conn_store::save_connections(&conns)?;

    Ok(())
}

// ── Transaction management ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn begin_transaction(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<(), String> {
    let driver = driver_for(&state, &conn_id).await?;
    driver.begin_transaction().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn commit_transaction(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<(), String> {
    let driver = driver_for(&state, &conn_id).await?;
    driver.commit_transaction().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rollback_transaction(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<(), String> {
    let driver = driver_for(&state, &conn_id).await?;
    driver.rollback_transaction().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn in_transaction(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<bool, String> {
    let driver = driver_for(&state, &conn_id).await?;
    Ok(driver.in_transaction().await)
}

// ── Menu sync ──────────────────────────────────────────────────────────────────

/// Keeps the native "Theme" menu's check marks in sync with the theme
/// selected in the webview (on boot and whenever it changes in-app).
/// No-op on platforms without the custom menu (the item map is empty).
#[tauri::command]
pub fn sync_theme_menu(state: State<AppState>, theme: String) {
    let items = state.theme_menu_items.lock().unwrap_or_else(|e| e.into_inner());
    for (id, item) in items.iter() {
        let _ = item.set_checked(*id == theme);
    }
}

#[derive(serde::Deserialize)]
pub struct QueryTabMenuInfo {
    id: String,
    title: String,
}

/// Rebuilds the native "Query" menu's list of open query tabs for the active
/// connection (already ordered by tab number by the caller), checking off
/// whichever one is active. No-op on platforms without the custom menu.
#[tauri::command]
pub fn sync_query_menu(
    app: tauri::AppHandle,
    state: State<AppState>,
    tabs: Vec<QueryTabMenuInfo>,
    active_tab_id: Option<String>,
) {
    let Some(query_menu) = state.query_menu.lock().unwrap_or_else(|e| e.into_inner()).clone() else {
        return;
    };

    let mut items = state.query_tab_items.lock().unwrap_or_else(|e| e.into_inner());
    for (_, item) in items.drain() {
        let _ = query_menu.remove(&item);
    }

    for tab in tabs {
        let checked = active_tab_id.as_deref() == Some(tab.id.as_str());
        if let Ok(item) = tauri::menu::CheckMenuItem::with_id(
            &app,
            format!("query-tab:{}", tab.id),
            tab.title,
            true,
            checked,
            None::<&str>,
        ) {
            let _ = query_menu.append(&item);
            items.insert(tab.id, item);
        }
    }
}
