use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::RwLock;
use dbkonn_core::drivers::DbConnection;

pub type ConnectionId = String;

#[derive(Default)]
pub struct AppState {
    /// Active open connections keyed by connection ID.
    ///
    /// Stored as `Arc` (not `Box`) so a request handler can clone its driver
    /// handle out under a brief read lock and then release the lock for the
    /// duration of the query. Holding the map's `RwLock` across every DB
    /// round-trip meant one slow query blocked every other connection's
    /// queries — and any queued `connect_db`/`disconnect_db` write behind it.
    pub connections: Arc<RwLock<HashMap<ConnectionId, Arc<dyn DbConnection>>>>,
    /// Native "Theme" menu items keyed by theme id, used to keep the check
    /// marks in sync with the theme selected in the webview. Populated on
    /// macOS only, where the custom menu bar is built; empty elsewhere.
    pub theme_menu_items: Mutex<HashMap<String, tauri::menu::CheckMenuItem<tauri::Wry>>>,
    /// Handle to the native "Query" submenu, so its tab list can be rebuilt
    /// as query tabs open/close/switch. `None` on platforms without it.
    pub query_menu: Mutex<Option<tauri::menu::Submenu<tauri::Wry>>>,
    /// The dynamic "open query tab" items currently appended to the Query
    /// menu, keyed by tab id, so they can be removed before each rebuild.
    pub query_tab_items: Mutex<HashMap<String, tauri::menu::CheckMenuItem<tauri::Wry>>>,
}
