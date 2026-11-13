//! Resumable LiteRT model downloads with SHA-256 verification.
//!
//! The model hub is the only place the app touches the network, and it talks
//! exclusively to the configured Hugging Face base URL. Partial files are kept
//! as `.part` siblings so an interrupted download resumes with a Range request.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::fs::OpenOptions as TokioOpenOptions;
use tokio::io::AsyncWriteExt;

use crate::error::{AppError, AppResult};
use crate::model_registry::{safe_model_filename, ModelArtifact, ModelFile};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadPhase {
    Downloading,
    Verifying,
    Complete,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub artifact_id: String,
    pub filename: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: f32,
    pub phase: DownloadPhase,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadReport {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub resumed_from: u64,
}

#[derive(Clone)]
pub struct ModelDownloader {
    client: reqwest::Client,
    base_url: String,
    models_dir: PathBuf,
}

impl ModelDownloader {
    pub fn new(base_url: impl Into<String>, models_dir: impl Into<PathBuf>) -> AppResult<Self> {
        let base_url = base_url.into();
        if !(base_url.starts_with("https://") || base_url.starts_with("http://127.0.0.1")) {
            return Err(AppError::Download(
                "model downloads require HTTPS (or loopback for tests)".into(),
            ));
        }
        let client = reqwest::Client::builder()
            .user_agent("UseMemo-model-downloader/0.1")
            .build()?;
        Ok(Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            models_dir: models_dir.into(),
        })
    }

    pub fn models_dir(&self) -> &Path {
        &self.models_dir
    }

    pub async fn download<F>(
        &self,
        artifact: &ModelArtifact,
        file: &ModelFile,
        mut on_progress: F,
    ) -> AppResult<DownloadReport>
    where
        F: FnMut(DownloadProgress),
    {
        let filename = safe_model_filename(&file.filename)?;
        if file.size_bytes == 0 {
            return Err(AppError::Download(
                "model file has zero expected size".into(),
            ));
        }
        let destination = artifact.local_path(&self.models_dir, filename);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let part = partial_path(&destination);
        let mut existing = fs::metadata(&part).map(|meta| meta.len()).unwrap_or(0);
        if existing > file.size_bytes {
            fs::remove_file(&part)?;
            existing = 0;
        }

        let url = artifact.download_url(&self.base_url, filename);
        let mut request = self.client.get(&url);
        if existing > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
        }
        let response = request.send().await?;
        let status = response.status();
        let resumed = existing > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
        if !resumed {
            if status != reqwest::StatusCode::OK {
                return Err(AppError::Download(format!(
                    "model download failed with HTTP {status}"
                )));
            }
            existing = 0;
        }
        if let Some(content_length) = response.content_length() {
            let expected = existing + content_length;
            if expected != file.size_bytes {
                return Err(AppError::Download(format!(
                    "size mismatch for {filename}: expected {}, server reports {expected}",
                    file.size_bytes
                )));
            }
        }

        let mut output = if resumed {
            TokioOpenOptions::new().append(true).open(&part).await?
        } else {
            TokioOpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&part)
                .await?
        };
        let mut downloaded = existing;
        on_progress(progress(
            artifact,
            file,
            downloaded,
            DownloadPhase::Downloading,
        ));
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            output.write_all(&chunk).await?;
            downloaded = downloaded.saturating_add(chunk.len() as u64);
            if downloaded > file.size_bytes {
                drop(output);
                let _ = fs::remove_file(&part);
                return Err(AppError::Download(format!(
                    "{filename} exceeded its declared {}-byte size",
                    file.size_bytes
                )));
            }
            on_progress(progress(
                artifact,
                file,
                downloaded,
                DownloadPhase::Downloading,
            ));
        }
        output.flush().await?;
        drop(output);

        if downloaded != file.size_bytes {
            return Err(AppError::Download(format!(
                "incomplete download for {filename}: {downloaded}/{} bytes",
                file.size_bytes
            )));
        }

        on_progress(progress(
            artifact,
            file,
            downloaded,
            DownloadPhase::Verifying,
        ));
        let part_for_hash = part.clone();
        let digest = tokio::task::spawn_blocking(move || sha256_file(&part_for_hash))
            .await
            .map_err(|error| AppError::Download(format!("hash task failed: {error}")))??;

        if let Some(expected) = file.sha256.as_deref() {
            if !expected.eq_ignore_ascii_case(&digest) {
                let _ = fs::remove_file(&part);
                return Err(AppError::Download(format!(
                    "SHA-256 mismatch for {filename}: expected {expected}, got {digest}"
                )));
            }
        }
        if destination.exists() {
            fs::remove_file(&destination)?;
        }
        fs::rename(&part, &destination)?;
        on_progress(progress(
            artifact,
            file,
            downloaded,
            DownloadPhase::Complete,
        ));

        Ok(DownloadReport {
            path: destination.to_string_lossy().into_owned(),
            bytes: downloaded,
            sha256: digest,
            resumed_from: if resumed { existing } else { 0 },
        })
    }

    pub async fn download_artifact<F>(
        &self,
        artifact: &ModelArtifact,
        mut on_progress: F,
    ) -> AppResult<Vec<DownloadReport>>
    where
        F: FnMut(DownloadProgress),
    {
        let mut reports = Vec::with_capacity(artifact.files.len());
        for file in &artifact.files {
            let report = self.download(artifact, file, &mut on_progress).await?;
            reports.push(report);
        }
        Ok(reports)
    }
}

pub fn partial_path(destination: &Path) -> PathBuf {
    let filename = destination
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "model".into());
    destination.with_file_name(format!("{filename}.part"))
}

pub fn sha256_file(path: &Path) -> AppResult<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_digest(hasher.finalize().as_slice()))
}

pub fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_digest(hasher.finalize().as_slice())
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn progress(
    artifact: &ModelArtifact,
    file: &ModelFile,
    downloaded: u64,
    phase: DownloadPhase,
) -> DownloadProgress {
    DownloadProgress {
        artifact_id: artifact.id.clone(),
        filename: file.filename.clone(),
        downloaded_bytes: downloaded,
        total_bytes: file.size_bytes,
        percent: if file.size_bytes == 0 {
            0.0
        } else {
            (downloaded as f64 / file.size_bytes as f64 * 100.0) as f32
        },
        phase,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_registry::ModelRole;
    use std::io::Write as _;
    use std::net::TcpListener;

    fn artifact(size: u64, sha: Option<String>) -> ModelArtifact {
        ModelArtifact {
            id: "test-model".into(),
            role: ModelRole::Asr,
            repo: "test/model".into(),
            files: vec![ModelFile {
                filename: "weights.bin".into(),
                size_bytes: size,
                sha256: sha,
            }],
            description: "test".into(),
            min_ram_gb: 0,
            recommended: false,
            accelerator: "cpu".into(),
        }
    }

    fn serve_once(body: Vec<u8>, resume_from: usize) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let read = socket.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..read]).to_string();
            let range = request
                .lines()
                .find(|line| line.to_ascii_lowercase().starts_with("range:"))
                .map(|line| line.trim().to_string())
                .unwrap_or_default();
            let (status, payload) = if range.is_empty() {
                ("200 OK", body.clone())
            } else {
                assert_eq!(
                    range.to_ascii_lowercase(),
                    format!("range: bytes={resume_from}-"),
                    "{request}"
                );
                ("206 Partial Content", body[resume_from..].to_vec())
            };
            let header = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Range: bytes {resume_from}-{}/{}\r\nConnection: close\r\n\r\n",
                payload.len(),
                body.len().saturating_sub(1),
                body.len()
            );
            socket.write_all(header.as_bytes()).unwrap();
            socket.write_all(&payload).unwrap();
            range
        });
        (format!("http://{address}"), handle)
    }

    #[tokio::test]
    async fn downloads_verifies_and_reports_complete() {
        let body = vec![7u8; 32 * 1024];
        let (base, server) = serve_once(body.clone(), 0);
        let dir = tempfile::tempdir().unwrap();
        let downloader = ModelDownloader::new(base, dir.path()).unwrap();
        let artifact = artifact(body.len() as u64, Some(sha256_bytes(&body)));
        let mut phases = Vec::new();
        let report = downloader
            .download(&artifact, &artifact.files[0], |update| {
                phases.push(update.phase)
            })
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(report.bytes, body.len() as u64);
        assert_eq!(report.resumed_from, 0);
        assert_eq!(fs::read(&report.path).unwrap(), body);
        assert!(phases.contains(&DownloadPhase::Downloading));
        assert!(phases.contains(&DownloadPhase::Verifying));
        assert_eq!(phases.last(), Some(&DownloadPhase::Complete));
        assert!(!partial_path(Path::new(&report.path)).exists());
    }

    #[tokio::test]
    async fn resumes_a_partial_file_with_a_range_request() {
        let body = vec![9u8; 40 * 1024];
        let resume_from = 12 * 1024;
        let (base, server) = serve_once(body.clone(), resume_from);
        let dir = tempfile::tempdir().unwrap();
        let artifact = artifact(body.len() as u64, Some(sha256_bytes(&body)));
        let destination = artifact.local_path(dir.path(), "weights.bin");
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::write(partial_path(&destination), &body[..resume_from]).unwrap();

        let downloader = ModelDownloader::new(base, dir.path()).unwrap();
        let report = downloader
            .download(&artifact, &artifact.files[0], |_| {})
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(report.resumed_from, resume_from as u64);
        assert_eq!(fs::read(&report.path).unwrap(), body);
    }

    #[tokio::test]
    async fn rejects_a_hash_mismatch_and_removes_the_partial() {
        let body = vec![3u8; 8 * 1024];
        let (base, server) = serve_once(body.clone(), 0);
        let dir = tempfile::tempdir().unwrap();
        let artifact = artifact(body.len() as u64, Some("00".repeat(32)));
        let downloader = ModelDownloader::new(base, dir.path()).unwrap();
        let error = downloader
            .download(&artifact, &artifact.files[0], |_| {})
            .await
            .unwrap_err();
        server.join().unwrap();
        assert!(error.to_string().contains("SHA-256 mismatch"));
        let destination = artifact.local_path(dir.path(), "weights.bin");
        assert!(!destination.exists());
        assert!(!partial_path(&destination).exists());
    }

    #[test]
    fn refuses_non_https_endpoints_except_loopback() {
        assert!(ModelDownloader::new("http://example.com", "/tmp/models").is_err());
        assert!(ModelDownloader::new("https://huggingface.co", "/tmp/models").is_ok());
        assert!(ModelDownloader::new("http://127.0.0.1:9999", "/tmp/models").is_ok());
    }

    #[test]
    fn sha256_matches_known_vector() {
        assert_eq!(
            sha256_bytes(b"hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[tokio::test]
    async fn refuses_path_traversal_filenames() {
        let dir = tempfile::tempdir().unwrap();
        let mut model = artifact(1, None);
        model.files[0].filename = "../escape.bin".into();
        let downloader = ModelDownloader::new("https://example.com", dir.path()).unwrap();
        let error = downloader
            .download(&model, &model.files[0], |_| {})
            .await
            .unwrap_err();
        assert!(error.to_string().contains("filename"));
    }
}
