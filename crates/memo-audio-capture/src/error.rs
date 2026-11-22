use thiserror::Error;

pub type AudioResult<T> = Result<T, AudioError>;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AudioError {
    #[error("invalid audio configuration: {0}")]
    InvalidConfig(String),
    #[error("audio source is not available: {0}")]
    Unavailable(String),
    #[error("audio source failed: {0}")]
    Source(String),
}
