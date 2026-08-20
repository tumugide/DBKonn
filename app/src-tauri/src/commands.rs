use dbkonn_core::{
    connection::ConnectionConfig,
    drivers,
    query::{ColumnInfo, IndexInfo, PageRequest, QueryResult, SchemaInfo, TableInfo},
    validator,
};
use tauri::State;

use crate::{
    connections as conn_store,
    state::AppState,
};

// ── Connection lifecycle ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn connect_db(
    state: State<'_, AppState>,
    mut config: ConnectionConfig,
) -> Result<String, String> {
    // Inject password from Keychain if not provided
    if config.password.is_none() {
        config.password = conn_store::get_password(&config.id);
    }

    let conn_id = config.id.clone();

    let driver = drivers::connect(&config)
        .await
        .map_err(|e| e.to_string())?;

    let mut conns = state.connections.write().await;
    conns.insert(conn_id.clone(), driver);

    Ok(conn_id)
}

#[tauri::command]
pub async fn disconnect_db(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<(), String> {
    let mut conns = state.connections.write().await;
    conns.remove(&conn_id);
    Ok(())
}

#[tauri::command]
pub async fn test_connection(mut config: ConnectionConfig) -> Result<bool, String> {
    // For test-connection, use whatever password is passed (transient, not saved)
    if config.password.is_none() {
        config.password = conn_store::get_password(&config.id);
    }
    let driver = drivers::connect(&config)
        .await
        .map_err(|e| e.to_string())?;
    driver.test_connection().await.map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn get_active_connections(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let conns = state.connections.read().await;
    Ok(conns.keys().cloned().collect())
}

// ── Schema discovery ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_databases(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<String>, String> {
    let conns = state.connections.read().await;
    let driver = conns.get(&conn_id).ok_or("Connection not found")?;
    driver.list_databases().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_database(
    state: State<'_, AppState>,
    conn_id: String,
    name: String,
) -> Result<(), String> {
    let conns = state.connections.read().await;
    let driver = conns.get(&conn_id).ok_or("Connection not found")?;
    driver.create_database(&name).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_schemas(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<SchemaInfo>, String> {
    let conns = state.connections.read().await;
    let driver = conns.get(&conn_id).ok_or("Connection not found")?;
    driver.list_schemas().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_tables(
    state: State<'_, AppState>,
    conn_id: String,
    schema: Option<String>,
) -> Result<Vec<TableInfo>, String> {
    let conns = state.connections.read().await;
    let driver = conns.get(&conn_id).ok_or("Connection not found")?;
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
    let conns = state.connections.read().await;
    let driver = conns.get(&conn_id).ok_or("Connection not found")?;
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
    let conns = state.connections.read().await;
    let driver = conns.get(&conn_id).ok_or("Connection not found")?;
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
    let conns = state.connections.read().await;
    let driver = conns.get(&conn_id).ok_or("Connection not found")?;
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
    let conns = state.connections.read().await;
    let driver = conns.get(&conn_id).ok_or("Connection not found")?;
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

    let mut conns = conn_store::load_connections();
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
    Ok(conn_store::load_connections())
}

#[tauri::command]
pub async fn delete_connection(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<(), String> {
    // Remove active connection if open
    {
        let mut conns = state.connections.write().await;
        conns.remove(&conn_id);
    }

    // Remove from Keychain
    conn_store::delete_password(&conn_id);

    // Remove from disk
    let mut conns = conn_store::load_connections();
    conns.retain(|c| c.id != conn_id);
    conn_store::save_connections(&conns)?;

    Ok(())
}

// ── Menu sync ──────────────────────────────────────────────────────────────────

/// Keeps the native "Theme" menu's check marks in sync with the theme
/// selected in the webview (on boot and whenever it changes in-app).
/// No-op on platforms without the custom menu (the item map is empty).
#[tauri::command]
pub fn sync_theme_menu(state: State<AppState>, theme: String) {
    let items = state.theme_menu_items.lock().unwrap();
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
    let Some(query_menu) = state.query_menu.lock().unwrap().clone() else {
        return;
    };

    let mut items = state.query_tab_items.lock().unwrap();
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
