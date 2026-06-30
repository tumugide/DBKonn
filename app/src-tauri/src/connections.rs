use dbkonn_core::connection::ConnectionConfig;
use std::path::PathBuf;

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

/// Delete password from macOS Keychain
pub fn delete_password(conn_id: &str) {
    if let Ok(entry) = keyring::Entry::new("DBKonn", conn_id) {
        let _ = entry.delete_password();
    }
}
