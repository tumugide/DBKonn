use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DbEngine {
    Postgres,
    MySQL,
    SQLite,
    MSSQL,
}

impl std::fmt::Display for DbEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DbEngine::Postgres => write!(f, "postgres"),
            DbEngine::MySQL => write!(f, "mysql"),
            DbEngine::SQLite => write!(f, "sqlite"),
            DbEngine::MSSQL => write!(f, "mssql"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    /// Unique identifier for saved connections
    pub id: String,
    /// Human-readable name
    pub name: String,
    pub engine: DbEngine,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    /// Password is stored in Keychain; this field is used only transiently in memory
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    pub database: Option<String>,
    /// Path for SQLite file databases
    pub file_path: Option<String>,
    pub ssl_mode: SslMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SslMode {
    #[default]
    Prefer,
    Require,
    Disable,
}

impl ConnectionConfig {
    pub fn connection_url(&self) -> String {
        match self.engine {
            DbEngine::Postgres => {
                let host = self.host.as_deref().unwrap_or("localhost");
                let port = self.port.unwrap_or(5432);
                let user = self.username.as_deref().unwrap_or("postgres");
                let db = self.database.as_deref().unwrap_or("postgres");
                let password = self.password.as_deref().unwrap_or("");
                if password.is_empty() {
                    format!("postgres://{}@{}:{}/{}", user, host, port, db)
                } else {
                    format!("postgres://{}:{}@{}:{}/{}", user, password, host, port, db)
                }
            }
            DbEngine::MySQL => {
                let host = self.host.as_deref().unwrap_or("localhost");
                let port = self.port.unwrap_or(3306);
                let user = self.username.as_deref().unwrap_or("root");
                let db = self.database.as_deref().unwrap_or("mysql");
                let password = self.password.as_deref().unwrap_or("");
                if password.is_empty() {
                    format!("mysql://{}@{}:{}/{}", user, host, port, db)
                } else {
                    format!("mysql://{}:{}@{}:{}/{}", user, password, host, port, db)
                }
            }
            DbEngine::SQLite => {
                let path = self.file_path.as_deref().unwrap_or(":memory:");
                format!("sqlite://{}", path)
            }
            DbEngine::MSSQL => {
                // tiberius uses its own config, not a URL — return a placeholder
                String::from("mssql://")
            }
        }
    }
}
