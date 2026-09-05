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
    /// Optional client-side TLS options beyond the basic SSL mode selector:
    /// a custom CA certificate to trust, a client certificate/key pair, and
    /// whether to verify the server hostname against the certificate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls: Option<TlsConfig>,
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

/// Client-side TLS options beyond the basic `SslMode` selector.
///
/// Only meaningful when `ssl_mode` is `Require` (or the engine's encrypted
/// mode). For Postgres/MySQL these map onto sqlx's `sslrootcert`/`sslcert`/
/// `sslkey` URL options and the `verify-full` / `VERIFY_IDENTITY` modes; for
/// MSSQL they map onto tiberius's `trust_cert_ca` (no client cert support).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct TlsConfig {
    /// Path to a PEM CA certificate to trust instead of the OS root store.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ca_cert_path: Option<String>,
    /// Path to a PEM client certificate (paired with `client_key_path`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_cert_path: Option<String>,
    /// Path to the PEM client private key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_key_path: Option<String>,
    /// Verify the server hostname matches the certificate (Postgres
    /// `verify-full`, MySQL `VERIFY_IDENTITY`). When false, the CA chain is
    /// still verified but the hostname is not.
    #[serde(default)]
    pub verify_hostname: bool,
}

impl ConnectionConfig {
    pub fn connection_url(&self) -> String {
        match self.engine {
            DbEngine::Postgres => {
                let host = self.host.as_deref().unwrap_or("localhost");
                let port = self.port.unwrap_or(5432);
                // Username/password/db are user-supplied and can contain
                // characters like `@ : / ? #` that are structural in a URL
                // (e.g. a password with a `#` gets read as the start of a
                // fragment, shifting everything after it — including the
                // port — out from under the parser, which then fails with
                // a confusing "invalid port number"). Percent-encode each
                // component so the URL always parses the way we intend.
                let user = Self::encode_url_component(self.username.as_deref().unwrap_or("postgres"));
                let db = Self::encode_url_component(self.database.as_deref().unwrap_or("postgres"));
                let password = Self::encode_url_component(self.password.as_deref().unwrap_or(""));
                // sqlx defaults to SslMode::Prefer when no `sslmode` param is
                // present, so this must always be spelled out explicitly —
                // otherwise the UI's SSL Mode selector (including "Disable")
                // has no effect on the actual connection.
                let sslmode = self.tls_pg_mode();
                let mut url_str = if password.is_empty() {
                    format!("postgres://{}@{}:{}/{}?sslmode={}", user, host, port, db, sslmode)
                } else {
                    format!(
                        "postgres://{}:{}@{}:{}/{}?sslmode={}",
                        user, password, host, port, db, sslmode
                    )
                };
                if let Some(ca) = self.tls_ca_cert_path() {
                    url_str.push_str(&format!("&sslrootcert={}", Self::encode_url_component(ca)));
                }
                if let (Some(cert), Some(key)) = (self.tls_client_cert(), self.tls_client_key()) {
                    url_str.push_str(&format!("&sslcert={}", Self::encode_url_component(cert)));
                    url_str.push_str(&format!("&sslkey={}", Self::encode_url_component(key)));
                }
                url_str
            }
            DbEngine::MySQL => {
                let host = self.host.as_deref().unwrap_or("localhost");
                let port = self.port.unwrap_or(3306);
                // See the Postgres branch above — same URL-injection risk
                // from unescaped user/password/db, same fix.
                let user = Self::encode_url_component(self.username.as_deref().unwrap_or("root"));
                let db = Self::encode_url_component(self.database.as_deref().unwrap_or("mysql"));
                let password = Self::encode_url_component(self.password.as_deref().unwrap_or(""));
                // Same rationale as Postgres above — sqlx-mysql defaults to
                // Preferred unless `ssl-mode` is spelled out explicitly.
                let sslmode = self.tls_mysql_mode();
                let mut url_str = if password.is_empty() {
                    format!("mysql://{}@{}:{}/{}?ssl-mode={}", user, host, port, db, sslmode)
                } else {
                    format!(
                        "mysql://{}:{}@{}:{}/{}?ssl-mode={}",
                        user, password, host, port, db, sslmode
                    )
                };
                if let Some(ca) = self.tls_ca_cert_path() {
                    url_str.push_str(&format!("&ssl-ca={}", Self::encode_url_component(ca)));
                }
                if let (Some(cert), Some(key)) = (self.tls_client_cert(), self.tls_client_key()) {
                    url_str.push_str(&format!("&ssl-cert={}", Self::encode_url_component(cert)));
                    url_str.push_str(&format!("&ssl-key={}", Self::encode_url_component(key)));
                }
                url_str
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

    /// Whether to verify the server hostname against the certificate. Only
    /// meaningful when `ssl_mode` is `Require` (verified modes); Prefer/Disable
    /// always report false so no conflicting URL params are emitted.
    fn tls_verify(&self) -> bool {
        self.ssl_mode == SslMode::Require
            && self.tls.as_ref().map(|t| t.verify_hostname).unwrap_or(false)
    }

    /// Whether any authenticated-TLS extras are configured (custom CA or a
    /// client cert/key pair). Presence upgrades an otherwise plain `Require`
    /// connection to a `verify-ca` URL so the CA pin actually takes effect.
    fn tls_has_extras(&self) -> bool {
        let Some(t) = &self.tls else { return false };
        t.ca_cert_path.is_some() || (t.client_cert_path.is_some() && t.client_key_path.is_some())
    }

    /// Effective sslmode for a Postgres URL.
    fn tls_pg_mode(&self) -> &'static str {
        match self.ssl_mode {
            SslMode::Prefer => "prefer",
            SslMode::Disable => "disable",
            SslMode::Require => {
                if self.tls_verify() {
                    "verify-full"
                } else if self.tls_has_extras() {
                    "verify-ca"
                } else {
                    "require"
                }
            }
        }
    }

    /// Effective ssl-mode for a MySQL URL.
    fn tls_mysql_mode(&self) -> &'static str {
        match self.ssl_mode {
            SslMode::Prefer => "PREFERRED",
            SslMode::Disable => "DISABLED",
            SslMode::Require => {
                if self.tls_verify() {
                    "VERIFY_IDENTITY"
                } else if self.tls_has_extras() {
                    "VERIFY_CA"
                } else {
                    "REQUIRED"
                }
            }
        }
    }

    /// URL-usable CA certificate path, or None when not configured for
    /// authenticated TLS (only applied in `Require` mode).
    fn tls_ca_cert_path(&self) -> Option<&str> {
        if self.ssl_mode != SslMode::Require {
            return None;
        }
        self.tls.as_ref()?.ca_cert_path.as_deref()
    }

    /// URL-usable client certificate path (paired with `tls_client_key`).
    fn tls_client_cert(&self) -> Option<&str> {
        if self.ssl_mode != SslMode::Require {
            return None;
        }
        self.tls.as_ref()?.client_cert_path.as_deref()
    }

    /// URL-usable client private key path (paired with `tls_client_cert`).
    fn tls_client_key(&self) -> Option<&str> {
        if self.ssl_mode != SslMode::Require {
            return None;
        }
        self.tls.as_ref()?.client_key_path.as_deref()
    }

    /// Percent-encode a URL user-info/path component (username, password,
    /// or database name) so structural URL characters within it (`@ : / ?
    /// #`) can't be misread as delimiters by the URL parser.
    fn encode_url_component(s: &str) -> String {
        percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
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

        let mut ssl_mode = SslMode::Prefer;
        let mut verify_hostname = false;
        let mut verified_mode_requested = false;
        if let Some((_, v)) = url
            .query_pairs()
            .find(|(k, _)| k == "sslmode" || k == "ssl" || k == "ssl-mode")
        {
            let v = v.to_lowercase().replace('_', "-");
            match v.as_str() {
                "require" | "required" | "true" | "on" | "1" => ssl_mode = SslMode::Require,
                "disable" | "disabled" | "false" | "off" | "0" => ssl_mode = SslMode::Disable,
                "verify-full" | "verify-identity" => {
                    ssl_mode = SslMode::Require;
                    verify_hostname = true;
                    verified_mode_requested = true;
                }
                "verify-ca" => {
                    ssl_mode = SslMode::Require;
                    verify_hostname = false;
                    verified_mode_requested = true;
                }
                // MySQL ssl-mode strings
                "preferred" => ssl_mode = SslMode::Prefer,
                _ => ssl_mode = SslMode::Prefer,
            }
        }

        let qp = |key: &str, alt: &str| {
            url.query_pairs()
                .find(|(k, _)| k == key || k == alt)
                .map(|(_, v)| decode(&v))
        };
        let ca = qp("sslrootcert", "ssl-ca").filter(|s| !s.is_empty());
        let cli_cert = qp("sslcert", "ssl-cert").filter(|s| !s.is_empty());
        let cli_key = qp("sslkey", "ssl-key").filter(|s| !s.is_empty());
        let tls = if verified_mode_requested || ca.is_some() || cli_cert.is_some() || cli_key.is_some()
        {
            Some(TlsConfig {
                ca_cert_path: ca,
                client_cert_path: cli_cert,
                client_key_path: cli_key,
                verify_hostname,
            })
        } else {
            None
        };

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
            tls,
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
    fn parses_verify_full_and_ca_path() {
        let cfg = ConnectionConfig::from_url(
            "postgres://u:p@h:5432/db?sslmode=verify-full&sslrootcert=/etc/pg/ca.pem",
        )
        .unwrap();
        assert_eq!(cfg.ssl_mode, SslMode::Require);
        let tls = cfg.tls.expect("tls config expected");
        assert!(tls.verify_hostname);
        assert_eq!(tls.ca_cert_path.as_deref(), Some("/etc/pg/ca.pem"));
    }

    #[test]
    fn verify_ca_keeps_hostname_verification_off() {
        let cfg =
            ConnectionConfig::from_url("postgres://u:p@h:5432/db?sslmode=verify-ca").unwrap();
        assert_eq!(cfg.ssl_mode, SslMode::Require);
        assert!(!cfg.tls.expect("tls").verify_hostname);
    }

    #[test]
    fn url_re_encodes_tls_options() {
        let cfg = ConnectionConfig {
            id: String::new(),
            name: String::new(),
            engine: DbEngine::Postgres,
            host: Some("h".to_string()),
            port: Some(5432),
            username: Some("u".to_string()),
            password: Some("p".to_string()),
            database: Some("db".to_string()),
            file_path: None,
            ssl_mode: SslMode::Require,
            tls: Some(TlsConfig {
                ca_cert_path: Some("/etc/pg/ca.pem".to_string()),
                client_cert_path: Some("/etc/pg/cli.crt".to_string()),
                client_key_path: Some("/etc/pg/cli.key".to_string()),
                verify_hostname: true,
            }),
            color: None,
        };
        let url = cfg.connection_url();
        assert!(url.contains("sslmode=verify-full"), "url: {url}");
        assert!(url.contains("sslrootcert="), "url: {url}");
        assert!(url.contains("sslcert="), "url: {url}");
        assert!(url.contains("sslkey="), "url: {url}");

        // Round-trip: parsing the URL must reconstruct the same TLS config.
        let parsed = ConnectionConfig::from_url(&url).unwrap();
        assert_eq!(parsed.tls.as_ref().map(|t| t.verify_hostname), Some(true));
        assert_eq!(parsed.tls.as_ref().and_then(|t| t.ca_cert_path.as_deref()), Some("/etc/pg/ca.pem"));
    }

    #[test]
    fn prefer_mode_emits_no_verify_url() {
        let cfg = ConnectionConfig {
            id: String::new(),
            name: String::new(),
            engine: DbEngine::MySQL,
            host: Some("h".to_string()),
            port: Some(3306),
            username: Some("u".to_string()),
            password: None,
            database: Some("db".to_string()),
            file_path: None,
            ssl_mode: SslMode::Prefer,
            tls: Some(TlsConfig {
                ca_cert_path: Some("/etc/mysql/ca.pem".to_string()),
                client_cert_path: None,
                client_key_path: None,
                verify_hostname: false,
            }),
            color: None,
        };
        let url = cfg.connection_url();
        // CA path is only wired up when the user asked for an authenticated
        // (Require) transport, so a Prefer mode must NOT append ssl-ca.
        assert!(url.contains("ssl-mode=PREFERRED"), "url: {url}");
        assert!(!url.contains("ssl-ca"), "url: {url}");
    }

    #[test]
    fn plain_require_keeps_legacy_sslmode() {
        // A Require connection with no TLS extras must keep emitting "require"
        // — not verify-ca — so existing self-signed-cert servers keep working.
        let cfg = ConnectionConfig {
            id: String::new(),
            name: String::new(),
            engine: DbEngine::Postgres,
            host: Some("h".to_string()),
            port: Some(5432),
            username: Some("u".to_string()),
            password: None,
            database: Some("db".to_string()),
            file_path: None,
            ssl_mode: SslMode::Require,
            tls: None,
            color: None,
        };
        let url = cfg.connection_url();
        assert!(url.contains("sslmode=require"), "url: {url}");
        assert!(!url.contains("verify-ca"), "url: {url}");
    }

    #[test]
    fn require_with_ca_upgrades_to_verify_ca() {
        let cfg = ConnectionConfig {
            id: String::new(),
            name: String::new(),
            engine: DbEngine::MySQL,
            host: Some("h".to_string()),
            port: Some(3306),
            username: Some("u".to_string()),
            password: None,
            database: Some("db".to_string()),
            file_path: None,
            ssl_mode: SslMode::Require,
            tls: Some(TlsConfig {
                ca_cert_path: Some("/etc/mysql/ca.pem".to_string()),
                client_cert_path: None,
                client_key_path: None,
                verify_hostname: false,
            }),
            color: None,
        };
        let url = cfg.connection_url();
        assert!(url.contains("ssl-mode=VERIFY_CA"), "url: {url}");
        assert!(url.contains("ssl-ca="), "url: {url}");
    }

    #[test]
    fn rejects_garbage_input() {
        assert!(ConnectionConfig::from_url("not a url").is_err());
    }
}
