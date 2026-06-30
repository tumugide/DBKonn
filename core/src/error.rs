use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("Connection error: {0}")]
    Connection(String),

    #[error("Query error: {0}")]
    Query(String),

    #[error("Unsupported operation: {0}")]
    Unsupported(String),

    #[error("Parse error: {message}")]
    ParseError {
        message: String,
        position: Option<usize>,
    },

    #[error("Driver error: {0}")]
    Driver(String),

    #[error("SQLx error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("Tiberius error: {0}")]
    Tiberius(#[from] tiberius::error::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl serde::Serialize for CoreError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
