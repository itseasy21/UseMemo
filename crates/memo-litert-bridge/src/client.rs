//! Spawning and request/response handling for the LiteRT-LM worker process.

use std::ffi::OsStr;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::{
    decode_response, encode_frame, read_frame_async, write_frame_async, BridgeError, BridgeResult,
    RequestEnvelope, WorkerRequest, WorkerResponse, PROTOCOL_VERSION,
};

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(180);

pub struct WorkerClient {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    next_id: u64,
    timeout: Duration,
}

impl WorkerClient {
    pub async fn spawn(program: impl AsRef<OsStr>, args: &[String]) -> BridgeResult<Self> {
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        let mut child = command.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| BridgeError::Protocol("worker stdin was not captured".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| BridgeError::Protocol("worker stdout was not captured".into()))?;
        Ok(Self {
            child,
            stdin,
            stdout,
            next_id: 1,
            timeout: DEFAULT_TIMEOUT,
        })
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn process_id(&self) -> Option<u32> {
        self.child.id()
    }

    /// Send one request and wait for its result. Token deltas are ignored.
    pub async fn request(&mut self, request: WorkerRequest) -> BridgeResult<WorkerResponse> {
        self.request_with_tokens(request, |_| {}).await
    }

    pub async fn request_with_tokens<F>(
        &mut self,
        request: WorkerRequest,
        mut on_token: F,
    ) -> BridgeResult<WorkerResponse>
    where
        F: FnMut(&str),
    {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        let payload = serde_json::to_vec(&RequestEnvelope {
            id,
            request: request.clone(),
        })?;
        write_frame_async(&mut self.stdin, &payload).await?;

        loop {
            let frame = tokio::time::timeout(self.timeout, read_frame_async(&mut self.stdout))
                .await
                .map_err(|_| BridgeError::Timeout(self.timeout))??;
            let frame = match frame {
                Some(frame) => frame,
                None => {
                    return Err(BridgeError::Protocol(
                        "worker closed stdout before replying".into(),
                    ))
                }
            };
            let response = decode_response(&frame)?;
            match &response {
                WorkerResponse::Token { id: token_id, text } => {
                    if *token_id == id {
                        on_token(text);
                    }
                }
                WorkerResponse::Result { id: result_id, .. } if *result_id == id => {
                    return Ok(response);
                }
                WorkerResponse::Error {
                    id: Some(error_id), ..
                } if *error_id == id => return Ok(response),
                WorkerResponse::Error { id: None, .. } => return Ok(response),
                _ => continue,
            }
        }
    }

    pub async fn hello(&mut self) -> BridgeResult<()> {
        let response = self
            .request(WorkerRequest::Hello {
                protocol_version: PROTOCOL_VERSION,
            })
            .await?;
        match response {
            WorkerResponse::Ready { .. } => Ok(()),
            WorkerResponse::Error { message, .. } => Err(BridgeError::Worker(message)),
            other => Err(BridgeError::Protocol(format!(
                "expected ready, got {}",
                response_name(&other)
            ))),
        }
    }

    pub async fn load_model(
        &mut self,
        model_path: impl Into<String>,
        backend: Option<String>,
        max_seq_len: Option<u32>,
    ) -> BridgeResult<()> {
        let response = self
            .request(WorkerRequest::Load {
                model_path: model_path.into(),
                backend,
                max_seq_len,
            })
            .await?;
        match response {
            WorkerResponse::Ready { .. } => Ok(()),
            WorkerResponse::Error { message, .. } => Err(BridgeError::Worker(message)),
            other => Err(BridgeError::Protocol(format!(
                "expected ready, got {}",
                response_name(&other)
            ))),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn generate<F>(
        &mut self,
        system: &str,
        user: &str,
        temperature: f32,
        top_p: f32,
        top_k: u32,
        max_output_tokens: u32,
        on_token: F,
    ) -> BridgeResult<String>
    where
        F: FnMut(&str),
    {
        self.generate_with_grammar(
            system,
            user,
            temperature,
            top_p,
            top_k,
            max_output_tokens,
            None,
            on_token,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn generate_with_grammar<F>(
        &mut self,
        system: &str,
        user: &str,
        temperature: f32,
        top_p: f32,
        top_k: u32,
        max_output_tokens: u32,
        grammar: Option<String>,
        mut on_token: F,
    ) -> BridgeResult<String>
    where
        F: FnMut(&str),
    {
        let response = self
            .request_with_tokens(
                WorkerRequest::Generate {
                    system: system.to_string(),
                    user: user.to_string(),
                    temperature,
                    top_p,
                    top_k,
                    max_output_tokens,
                    grammar,
                },
                &mut on_token,
            )
            .await?;
        match response {
            WorkerResponse::Result { text, .. } => Ok(text),
            WorkerResponse::Error { message, .. } => Err(BridgeError::Worker(message)),
            other => Err(BridgeError::Protocol(format!(
                "expected result, got {}",
                response_name(&other)
            ))),
        }
    }

    pub async fn shutdown(mut self) -> BridgeResult<()> {
        let _ = self.request(WorkerRequest::Shutdown).await;
        match tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await {
            Ok(result) => {
                result?;
            }
            Err(_) => {
                self.child.start_kill()?;
            }
        }
        Ok(())
    }

    pub async fn kill(mut self) -> BridgeResult<()> {
        self.child.start_kill()?;
        let _ = self.child.wait().await;
        Ok(())
    }
}

fn response_name(response: &WorkerResponse) -> &'static str {
    match response {
        WorkerResponse::Ready { .. } => "ready",
        WorkerResponse::Token { .. } => "token",
        WorkerResponse::Result { .. } => "result",
        WorkerResponse::Error { .. } => "error",
        WorkerResponse::Pong => "pong",
    }
}

/// Generic frame-level client used by tests and embedders that already own the
/// pipes (for example an in-process mock worker).
pub struct FrameChannel<R, W> {
    reader: R,
    writer: W,
}

impl<R: AsyncRead + Unpin, W: AsyncWrite + Unpin> FrameChannel<R, W> {
    pub fn new(reader: R, writer: W) -> Self {
        Self { reader, writer }
    }

    pub async fn send(&mut self, id: u64, request: &WorkerRequest) -> BridgeResult<()> {
        let payload = serde_json::to_vec(&RequestEnvelope {
            id,
            request: request.clone(),
        })?;
        write_frame_async(&mut self.writer, &payload).await
    }

    pub async fn receive(&mut self) -> BridgeResult<Option<WorkerResponse>> {
        match read_frame_async(&mut self.reader).await? {
            Some(frame) => Ok(Some(decode_response(&frame)?)),
            None => Ok(None),
        }
    }

    pub async fn send_payload(&mut self, payload: &[u8]) -> BridgeResult<()> {
        write_frame_async(&mut self.writer, payload).await
    }
}

// Keep the raw frame helper used by the worker docs discoverable.
pub fn frame_for_json(value: &serde_json::Value) -> BridgeResult<Vec<u8>> {
    let bytes = serde_json::to_vec(value)?;
    encode_frame(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frame_channel_roundtrips_over_duplex_pipes() {
        let (client_read, mut server_write) = tokio::io::duplex(4_096);
        let (mut server_read, client_write) = tokio::io::duplex(4_096);
        let mut client = FrameChannel::new(client_read, client_write);
        let server = tokio::spawn(async move {
            let payload = read_frame_async(&mut server_read).await.unwrap().unwrap();
            let request: serde_json::Value = serde_json::from_slice(&payload).unwrap();
            let id = request["id"].as_u64().unwrap();
            let response = serde_json::json!({"type":"result","id":id,"text":"ok"});
            write_frame_async(&mut server_write, &serde_json::to_vec(&response).unwrap())
                .await
                .unwrap();
        });
        client
            .send(
                4,
                &WorkerRequest::Generate {
                    system: "s".into(),
                    user: "u".into(),
                    temperature: 0.0,
                    top_p: 1.0,
                    top_k: 1,
                    max_output_tokens: 8,
                    grammar: None,
                },
            )
            .await
            .unwrap();
        let response = client.receive().await.unwrap().unwrap();
        assert_eq!(response.id(), Some(4));
        server.await.unwrap();
    }

    #[test]
    fn frame_helper_carries_json() {
        let framed = frame_for_json(&serde_json::json!({"type":"ping"})).unwrap();
        let mut cursor = std::io::Cursor::new(framed);
        let payload = crate::read_frame(&mut cursor).unwrap().unwrap();
        let value: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(value["type"], "ping");
    }
}
