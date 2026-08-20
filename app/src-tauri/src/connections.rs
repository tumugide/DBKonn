use dbkonn_core::connection::ConnectionConfig;
use std::path::PathBuf;
use std::time::Duration;

const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(15);

pub fn config_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("DBKonn")
}

pub fn connections_path() -> PathBuf {
    config_dir().join("connections.json")
}

pub fn load_connections() -> Vec<ConnectionConfig> {
    let path = connections_path();
    if !path.exists() {
        return vec![];
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_connections(conns: &[ConnectionConfig]) -> Result<(), String> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(conns).map_err(|e| e.to_string())?;
    std::fs::write(connections_path(), json).map_err(|e| e.to_string())?;
    Ok(())
}

/// Store password in macOS Keychain
pub fn store_password(conn_id: &str, password: &str) -> Result<(), String> {
    let entry = keyring::Entry::new("DBKonn", conn_id).map_err(|e| e.to_string())?;
    entry.set_password(password).map_err(|e| e.to_string())?;
    Ok(())
}

/// Retrieve password from macOS Keychain
pub fn get_password(conn_id: &str) -> Option<String> {
    let entry = keyring::Entry::new("DBKonn", conn_id).ok()?;
    entry.get_password().ok()
}

/// Retrieve password from macOS Keychain without blocking the async runtime.
///
/// Keychain access can block on a native "Allow/Deny" authorization dialog
/// (e.g. after a rebuild changes the app's code signature, macOS treats it
/// as a different, unauthorized app and re-prompts). Calling `get_password`
/// directly on an async task would freeze that task — and anything sharing
/// its executor thread — until the dialog is answered, which looks like an
/// endless "Connecting…" spinner with no indication a system dialog is
/// waiting. `spawn_blocking` keeps the call off the async threads, and the
/// timeout turns an unanswered dialog into a clear, actionable error.
pub async fn get_password_async(conn_id: &str) -> Result<Option<String>, String> {
    let conn_id = conn_id.to_string();
    match tokio::time::timeout(
        KEYCHAIN_TIMEOUT,
        tokio::task::spawn_blocking(move || get_password(&conn_id)),
    )
    .await
    {
        Ok(join_result) => Ok(join_result.unwrap_or(None)),
        Err(_) => Err(
            "Timed out waiting for macOS Keychain access. Check for a system \
             permission dialog (it may be behind this window) and click Allow."
                .to_string(),
        ),
    }
}

/// Delete password from macOS Keychain
pub fn delete_password(conn_id: &str) {
    if let Ok(entry) = keyring::Entry::new("DBKonn", conn_id) {
        let _ = entry.delete_password();
    }
}
