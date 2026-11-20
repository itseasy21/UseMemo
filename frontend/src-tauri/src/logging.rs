//! Bounded, size-rotating local JSONL logger for air-gapped diagnostics.
//!
//! GUI desktop and mobile builds detach `stderr`, and the air-gap policy
//! prohibits remote crash/log collectors. This subscriber writes structured
//! JSON Lines to `<cache_dir>/logs/memo.jsonl` with automatic 3-file rotation
//! (`5 MiB` per file, max `15 MiB` disk footprint).

use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use chrono::Utc;
use serde::Serialize;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Metadata, Subscriber};

pub const MAX_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;
pub const MAX_ROTATED_FILES: usize = 2;

static ACTIVE_LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

struct RotatingWriter {
    dir: PathBuf,
    current_path: PathBuf,
    file: Option<File>,
    size_bytes: u64,
}

impl RotatingWriter {
    fn open(dir: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&dir)?;
        let current_path = dir.join("memo.jsonl");
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&current_path)?;
        let size_bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self {
            dir,
            current_path,
            file: Some(file),
            size_bytes,
        })
    }

    fn write_line(&mut self, line: &str) {
        let needed = line.len() as u64 + 1;
        if self.size_bytes + needed > MAX_LOG_FILE_BYTES {
            let _ = self.rotate();
        }
        if let Some(file) = self.file.as_mut() {
            if file.write_all(line.as_bytes()).is_ok() && file.write_all(b"\n").is_ok() {
                let _ = file.flush();
                self.size_bytes += needed;
            }
        }
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        if let Some(mut file) = self.file.take() {
            let _ = file.flush();
        }
        for index in (1..=MAX_ROTATED_FILES).rev() {
            let src = if index == 1 {
                self.current_path.clone()
            } else {
                self.dir.join(format!("memo.jsonl.{}", index - 1))
            };
            let dst = self.dir.join(format!("memo.jsonl.{index}"));
            if src.is_file() {
                let _ = fs::rename(&src, &dst);
            }
        }
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&self.current_path)?;
        self.file = Some(file);
        self.size_bytes = 0;
        Ok(())
    }
}

struct JsonlSubscriber {
    writer: Arc<Mutex<RotatingWriter>>,
    next_span_id: AtomicU64,
    min_level: Level,
}

#[derive(Default)]
struct FieldCollector {
    message: String,
    fields: serde_json::Map<String, serde_json::Value>,
}

impl Visit for FieldCollector {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            self.fields.insert(
                field.name().to_string(),
                serde_json::Value::String(value.into()),
            );
        }
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.fields
            .insert(field.name().to_string(), serde_json::Value::from(value));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.fields
            .insert(field.name().to_string(), serde_json::Value::from(value));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.fields
            .insert(field.name().to_string(), serde_json::Value::from(value));
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let mut rendered = String::new();
        let _ = write!(&mut rendered, "{value:?}");
        if field.name() == "message" {
            self.message = rendered;
        } else {
            self.fields.insert(
                field.name().to_string(),
                serde_json::Value::String(rendered),
            );
        }
    }
}

#[derive(Serialize)]
struct LogRecord<'a> {
    ts: String,
    level: &'a str,
    target: &'a str,
    message: String,
    #[serde(skip_serializing_if = "serde_json::Map::is_empty")]
    fields: serde_json::Map<String, serde_json::Value>,
}

impl Subscriber for JsonlSubscriber {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        *metadata.level() <= self.min_level
    }

    fn new_span(&self, _span: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(self.next_span_id.fetch_add(1, Ordering::Relaxed))
    }

    fn record(&self, _span: &tracing::span::Id, _values: &tracing::span::Record<'_>) {}

    fn record_follows_from(&self, _span: &tracing::span::Id, _follows: &tracing::span::Id) {}

    fn event(&self, event: &Event<'_>) {
        let meta = event.metadata();
        if !self.enabled(meta) {
            return;
        }
        let mut collector = FieldCollector::default();
        event.record(&mut collector);
        let record = LogRecord {
            ts: Utc::now().to_rfc3339(),
            level: meta.level().as_str(),
            target: meta.target(),
            message: collector.message,
            fields: collector.fields,
        };
        if let Ok(serialized) = serde_json::to_string(&record) {
            if let Ok(mut guard) = self.writer.lock() {
                guard.write_line(&serialized);
            }
        }
    }

    fn enter(&self, _span: &tracing::span::Id) {}

    fn exit(&self, _span: &tracing::span::Id) {}
}

/// Initialize global structured file logging under `<cache_dir>/logs`.
/// Safe to call multiple times; subsequent calls return the active log directory.
pub fn init_logging(cache_dir: &Path) -> PathBuf {
    let logs_dir = cache_dir.join("logs");
    if let Some(existing) = ACTIVE_LOG_DIR.get() {
        return existing.clone();
    }
    if let Ok(writer) = RotatingWriter::open(logs_dir.clone()) {
        let subscriber = JsonlSubscriber {
            writer: Arc::new(Mutex::new(writer)),
            next_span_id: AtomicU64::new(1),
            min_level: Level::INFO,
        };
        let _ = tracing::subscriber::set_global_default(subscriber);
        let _ = ACTIVE_LOG_DIR.set(logs_dir.clone());
    }
    logs_dir
}

pub fn active_log_dir(cache_dir: &Path) -> PathBuf {
    ACTIVE_LOG_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| cache_dir.join("logs"))
}

/// Read up to `max_lines` of the most recent structured log entries.
pub fn read_recent_logs(cache_dir: &Path, max_lines: usize) -> Vec<String> {
    let dir = active_log_dir(cache_dir);
    let mut lines = Vec::new();
    for filename in ["memo.jsonl.1", "memo.jsonl"] {
        let path = dir.join(filename);
        if let Ok(raw) = fs::read_to_string(&path) {
            lines.extend(raw.lines().map(ToOwned::to_owned));
        }
    }
    if lines.len() > max_lines {
        lines.split_off(lines.len() - max_lines)
    } else {
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotating_writer_rolls_files_at_size_cap() {
        let temp = tempfile::tempdir().unwrap();
        let mut writer = RotatingWriter::open(temp.path().to_path_buf()).unwrap();
        writer.size_bytes = MAX_LOG_FILE_BYTES - 4;
        writer.write_line("{\"msg\":\"trigger-rotate\"}");
        assert!(temp.path().join("memo.jsonl").is_file());
        assert!(temp.path().join("memo.jsonl.1").is_file());
    }
}
