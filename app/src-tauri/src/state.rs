use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use dbkonn_core::drivers::DbConnection;

pub type ConnectionId = String;

#[derive(Default)]
pub struct AppState {
    /// Active open connections keyed by connection ID
    pub connections: Arc<RwLock<HashMap<ConnectionId, Box<dyn DbConnection>>>>,
}
