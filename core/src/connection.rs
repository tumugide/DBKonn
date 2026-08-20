use serde::{Deserialize, Serialize};

use crate::error::CoreError;

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
    /// User-assigned color tag (hex, e.g. "#e06c75") for telling connections
    /// apart at a glance — e.g. red for production, green for local.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
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
                // sqlx defaults to SslMode::Prefer when no `sslmode` param is
                // present, so this must always be spelled out explicitly —
                // otherwise the UI's SSL Mode selector (including "Disable")
                // has no effect on the actual connection.
                let sslmode = match self.ssl_mode {
                    SslMode::Prefer => "prefer",
                    SslMode::Require => "require",
                    SslMode::Disable => "disable",
                };
                if password.is_empty() {
                    format!("postgres://{}@{}:{}/{}?sslmode={}", user, host, port, db, sslmode)
                } else {
                    format!(
                        "postgres://{}:{}@{}:{}/{}?sslmode={}",
                        user, password, host, port, db, sslmode
                    )
                }
            }
            DbEngine::MySQL => {
                let host = self.host.as_deref().unwrap_or("localhost");
                let port = self.port.unwrap_or(3306);
                let user = self.username.as_deref().unwrap_or("root");
                let db = self.database.as_deref().unwrap_or("mysql");
                let password = self.password.as_deref().unwrap_or("");
                // Same rationale as Postgres above — sqlx-mysql defaults to
                // Preferred unless `ssl-mode` is spelled out explicitly.
                let sslmode = match self.ssl_mode {
                    SslMode::Prefer => "PREFERRED",
                    SslMode::Require => "REQUIRED",
                    SslMode::Disable => "DISABLED",
                };
                if password.is_empty() {
                    format!("mysql://{}@{}:{}/{}?ssl-mode={}", user, host, port, db, sslmode)
                } else {
                    format!(
                        "mysql://{}:{}@{}:{}/{}?ssl-mode={}",
                        user, password, host, port, db, sslmode
                    )
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

    /// Parse a connection URL/DSN (e.g. `postgres://user:pass@host:5432/db`)
    /// into a `ConnectionConfig`. `id` and `name` are left blank — callers
    /// populate those from the connection being edited, not from the URL.
    pub fn from_url(url_str: &str) -> Result<ConnectionConfig, CoreError> {
        let url = url::Url::parse(url_str.trim()).map_err(|e| CoreError::ParseError {
            message: format!("Invalid connection URL: {}", e),
            position: None,
        })?;

        let engine = match url.scheme() {
            "postgres" | "postgresql" => DbEngine::Postgres,
            "mysql" => DbEngine::MySQL,
            "sqlite" => DbEngine::SQLite,
            "mssql" | "sqlserver" => DbEngine::MSSQL,
            other => {
                return Err(CoreError::ParseError {
                    message: format!(
                        "Unsupported connection URL scheme '{}': expected postgres(ql)://, mysql://, sqlite://, or mssql:// / sqlserver://",
                        other
                    ),
                    position: None,
                })
            }
        };

        let decode = |s: &str| -> String {
            percent_encoding::percent_decode_str(s)
                .decode_utf8_lossy()
                .into_owned()
        };

        let username = if url.username().is_empty() {
            None
        } else {
            Some(decode(url.username()))
        };
        let password = url.password().map(decode);

        let (host, port, database, file_path) = if engine == DbEngine::SQLite {
            // Everything after the scheme is a filesystem path, not a network
            // authority. The url crate may split a relative-looking path across
            // both `host` (e.g. "sqlite://relative.db") and `path` (e.g.
            // "sqlite:///abs/path.db" -> host "" + path "/abs/path.db") —
            // reconstruct the original path in both cases.
            let mut path = url.path().to_string();
            if let Some(h) = url.host_str() {
                if !h.is_empty() {
                    path = format!("{}{}", h, path);
                }
            }
            (None, None, None, Some(path))
        } else {
            let host = url.host_str().map(|h| h.to_string());
            let port = url.port();
            let database = {
                let p = url.path().trim_start_matches('/');
                if p.is_empty() {
                    None
                } else {
                    Some(p.to_string())
                }
            };
            (host, port, database, None)
        };

        let ssl_mode = url
            .query_pairs()
            .find(|(k, _)| k == "sslmode" || k == "ssl")
            .map(|(_, v)| match v.to_lowercase().as_str() {
                "require" | "required" | "true" | "on" | "1" => SslMode::Require,
                "disable" | "disabled" | "false" | "off" | "0" => SslMode::Disable,
                _ => SslMode::Prefer,
            })
            .unwrap_or(SslMode::Prefer);

        Ok(ConnectionConfig {
            id: String::new(),
            name: String::new(),
            engine,
            host,
            port,
            username,
            password,
            database,
            file_path,
            ssl_mode,
            color: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_postgres_url_with_domain_host() {
        let cfg =
            ConnectionConfig::from_url("postgres://alice:s3cret@db.example.com:5432/appdb?sslmode=require")
                .unwrap();
        assert_eq!(cfg.engine, DbEngine::Postgres);
        assert_eq!(cfg.host.as_deref(), Some("db.example.com"));
        assert_eq!(cfg.port, Some(5432));
        assert_eq!(cfg.username.as_deref(), Some("alice"));
        assert_eq!(cfg.password.as_deref(), Some("s3cret"));
        assert_eq!(cfg.database.as_deref(), Some("appdb"));
        assert_eq!(cfg.ssl_mode, SslMode::Require);
    }

    #[test]
    fn parses_postgres_url_with_ipv4_host_and_no_port() {
        let cfg = ConnectionConfig::from_url("postgres://alice@10.0.0.5/appdb").unwrap();
        assert_eq!(cfg.host.as_deref(), Some("10.0.0.5"));
        assert_eq!(cfg.port, None);
        assert_eq!(cfg.password, None);
        assert_eq!(cfg.ssl_mode, SslMode::Prefer);
    }

    #[test]
    fn parses_mysql_url_with_ipv6_host() {
        let cfg = ConnectionConfig::from_url("mysql://root:pw@[::1]:3306/mydb").unwrap();
        assert_eq!(cfg.engine, DbEngine::MySQL);
        // url::Url keeps the brackets in host_str() for IPv6 literals (per the
        // WHATWG host-serialization spec). We keep them too: connection_url()
        // and tiberius's get_addr() both naively concatenate "host:port"
        // downstream, and that's only unambiguous for IPv6 when bracketed.
        assert_eq!(cfg.host.as_deref(), Some("[::1]"));
        assert_eq!(cfg.port, Some(3306));
    }

    #[test]
    fn parses_sqlite_absolute_path() {
        let cfg = ConnectionConfig::from_url("sqlite:///Users/me/data/app.sqlite").unwrap();
        assert_eq!(cfg.engine, DbEngine::SQLite);
        assert_eq!(cfg.file_path.as_deref(), Some("/Users/me/data/app.sqlite"));
        assert_eq!(cfg.host, None);
    }

    #[test]
    fn parses_mssql_url_with_explicit_nondefault_port() {
        let cfg = ConnectionConfig::from_url("mssql://sa:Passw0rd!@host:14330/db").unwrap();
        assert_eq!(cfg.engine, DbEngine::MSSQL);
        assert_eq!(cfg.host.as_deref(), Some("host"));
        assert_eq!(cfg.port, Some(14330));
        assert_eq!(cfg.password.as_deref(), Some("Passw0rd!"));
    }

    #[test]
    fn decodes_percent_encoded_credentials() {
        let cfg = ConnectionConfig::from_url("postgres://us%40er:p%40ss@host/db").unwrap();
        assert_eq!(cfg.username.as_deref(), Some("us@er"));
        assert_eq!(cfg.password.as_deref(), Some("p@ss"));
    }

    #[test]
    fn rejects_unsupported_scheme() {
        let err = ConnectionConfig::from_url("oracle://host/db").unwrap_err();
        assert!(matches!(err, CoreError::ParseError { .. }));
    }

    #[test]
    fn rejects_garbage_input() {
        assert!(ConnectionConfig::from_url("not a url").is_err());
    }
}
