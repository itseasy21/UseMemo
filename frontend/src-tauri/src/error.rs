use serde::ser::{Serialize, Serializer};

/// Application-wide error type. Every variant is safe to surface to the local UI:
/// no secrets or network payloads are embedded.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("migration error: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid data: {0}")]
    Json(#[from] serde_json::Error),
    #[error("image error: {0}")]
    Image(#[from] image::ImageError),
    #[error("network error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("synthesis error: {0}")]
    Synthesis(String),
    #[error("verification error: {0}")]
    Verification(String),
    #[error("download error: {0}")]
    Download(String),
    #[error("capture error: {0}")]
    Capture(String),
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid(message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
