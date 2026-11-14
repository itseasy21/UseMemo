//! Length-prefixed stdio protocol shared by the Rust client and the C++ worker.
//!
//! Frame layout: `u32` big-endian payload length followed by UTF-8 JSON.
//! A frame is capped at 16 MiB to keep a corrupt worker from exhausting memory.

use std::io::{Read, Write};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub mod client;

pub use client::{FrameChannel, WorkerClient, DEFAULT_TIMEOUT};

pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("bridge I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("bridge protocol error: {0}")]
    Protocol(String),
    #[error("worker error: {0}")]
    Worker(String),
    #[error("worker timed out after {0:?}")]
    Timeout(std::time::Duration),
    #[error("bridge JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type BridgeResult<T> = Result<T, BridgeError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestEnvelope {
    pub id: u64,
    #[serde(flatten)]
    pub request: WorkerRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WorkerRequest {
    Hello {
        protocol_version: u32,
    },
    Load {
        model_path: String,
        #[serde(default)]
        backend: Option<String>,
        #[serde(default)]
        max_seq_len: Option<u32>,
    },
    Generate {
        system: String,
        user: String,
        temperature: f32,
        top_p: f32,
        top_k: u32,
        max_output_tokens: u32,
    },
    Ping,
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WorkerResponse {
    Ready {
        protocol_version: u32,
        #[serde(default)]
        backend: Option<String>,
        #[serde(default)]
        model: Option<String>,
    },
    Token {
        id: u64,
        text: String,
    },
    Result {
        id: u64,
        text: String,
    },
    Error {
        #[serde(default)]
        id: Option<u64>,
        message: String,
    },
    Pong,
}

impl WorkerResponse {
    pub fn id(&self) -> Option<u64> {
        match self {
            Self::Token { id, .. } | Self::Result { id, .. } => Some(*id),
            Self::Error { id, .. } => *id,
            Self::Ready { .. } | Self::Pong => None,
        }
    }
}

pub fn encode_frame(payload: &[u8]) -> BridgeResult<Vec<u8>> {
    if payload.len() > MAX_FRAME_BYTES {
        return Err(BridgeError::Protocol(format!(
            "frame is {} bytes, limit is {MAX_FRAME_BYTES}",
            payload.len()
        )));
    }
    let mut framed = Vec::with_capacity(4 + payload.len());
    framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    framed.extend_from_slice(payload);
    Ok(framed)
}

pub fn encode_request(id: u64, request: &WorkerRequest) -> BridgeResult<Vec<u8>> {
    let payload = serde_json::to_vec(&RequestEnvelope {
        id,
        request: request.clone(),
    })?;
    encode_frame(&payload)
}

pub fn decode_response(payload: &[u8]) -> BridgeResult<WorkerResponse> {
    Ok(serde_json::from_slice(payload)?)
}

/// Synchronous framing helpers for tests and non-Tokio embedders.
pub fn write_frame<W: Write>(writer: &mut W, payload: &[u8]) -> BridgeResult<()> {
    writer.write_all(&encode_frame(payload)?)?;
    writer.flush()?;
    Ok(())
}

pub fn read_frame<R: Read>(reader: &mut R) -> BridgeResult<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let length = u32::from_be_bytes(header) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(BridgeError::Protocol(format!(
            "declared frame length {length} exceeds limit"
        )));
    }
    let mut payload = vec![0u8; length];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

pub async fn write_frame_async<W: AsyncWrite + Unpin>(
    writer: &mut W,
    payload: &[u8],
) -> BridgeResult<()> {
    writer.write_all(&encode_frame(payload)?).await?;
    writer.flush().await?;
    Ok(())
}

pub async fn read_frame_async<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> BridgeResult<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    match reader.read_exact(&mut header).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let length = u32::from_be_bytes(header) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(BridgeError::Protocol(format!(
            "declared frame length {length} exceeds limit"
        )));
    }
    let mut payload = vec![0u8; length];
    reader.read_exact(&mut payload).await?;
    Ok(Some(payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frame_roundtrip_is_big_endian_length_prefixed() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, b"{\"type\":\"ping\"}").unwrap();
        assert_eq!(&buffer[..4], &(15u32).to_be_bytes());
        let payload = read_frame(&mut Cursor::new(buffer)).unwrap().unwrap();
        assert_eq!(payload, b"{\"type\":\"ping\"}");
    }

    #[test]
    fn eof_and_truncation_are_distinct() {
        assert!(read_frame(&mut Cursor::new(Vec::new())).unwrap().is_none());
        let mut truncated = Vec::new();
        truncated.extend_from_slice(&8u32.to_be_bytes());
        truncated.extend_from_slice(b"short");
        assert!(read_frame(&mut Cursor::new(truncated)).is_err());
    }

    #[test]
    fn oversize_frames_are_rejected_before_allocation() {
        let mut header = Vec::new();
        header.extend_from_slice(&((MAX_FRAME_BYTES + 1) as u32).to_be_bytes());
        let error = read_frame(&mut Cursor::new(header)).unwrap_err();
        assert!(matches!(error, BridgeError::Protocol(_)));
        assert!(encode_frame(&vec![0u8; MAX_FRAME_BYTES + 1]).is_err());
    }

    #[test]
    fn requests_are_tagged_and_use_camel_case_fields() {
        let encoded = encode_request(
            7,
            &WorkerRequest::Generate {
                system: "s".into(),
                user: "u".into(),
                temperature: 0.0,
                top_p: 1.0,
                top_k: 1,
                max_output_tokens: 128,
            },
        )
        .unwrap();
        let payload = read_frame(&mut Cursor::new(encoded)).unwrap().unwrap();
        let value: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(value["id"], 7);
        assert_eq!(value["type"], "generate");
        assert_eq!(value["maxOutputTokens"], 128);
    }

    #[test]
    fn responses_parse_all_variants() {
        let ready: WorkerResponse =
            serde_json::from_str(r#"{"type":"ready","protocolVersion":1,"backend":"metal"}"#)
                .unwrap();
        assert!(matches!(ready, WorkerResponse::Ready { .. }));
        let token: WorkerResponse =
            serde_json::from_str(r#"{"type":"token","id":2,"text":"hi"}"#).unwrap();
        assert_eq!(token.id(), Some(2));
        let error: WorkerResponse =
            serde_json::from_str(r#"{"type":"error","id":3,"message":"boom"}"#).unwrap();
        assert_eq!(error.id(), Some(3));
    }

    #[tokio::test]
    async fn async_framing_matches_sync_framing() {
        let (mut client, mut server) = tokio::io::duplex(1024);
        let writer = tokio::spawn(async move {
            write_frame_async(&mut client, b"hello").await.unwrap();
        });
        let payload = read_frame_async(&mut server).await.unwrap().unwrap();
        assert_eq!(payload, b"hello");
        writer.await.unwrap();
    }
}
