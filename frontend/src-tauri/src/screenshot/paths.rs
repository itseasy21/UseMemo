//! Deterministic screenshot filenames and Markdown-relative links.

use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// `shot-000010-0123456789abcdef.webp`
pub fn screenshot_filename(captured_at_ms: i64, dhash: u64) -> String {
    let seconds = (captured_at_ms.max(0) / 1_000) as u64;
    format!("shot-{seconds:06}-{dhash:016x}.webp")
}

#[derive(Debug, Clone)]
pub struct ScreenshotPathPlanner {
    shots_dir: PathBuf,
}

impl ScreenshotPathPlanner {
    pub fn new(shots_dir: impl Into<PathBuf>) -> Self {
        Self {
            shots_dir: shots_dir.into(),
        }
    }

    pub fn shots_dir(&self) -> &Path {
        &self.shots_dir
    }

    /// Absolute path for a new frame. If a frame with the same second and hash
    /// already exists, a numeric suffix keeps history append-only.
    pub fn plan(&self, captured_at_ms: i64, dhash: u64) -> PathBuf {
        let base = screenshot_filename(captured_at_ms, dhash);
        let mut candidate = self.shots_dir.join(&base);
        if !candidate.exists() {
            return candidate;
        }
        let stem = base.trim_end_matches(".webp");
        for suffix in 1..10_000 {
            candidate = self.shots_dir.join(format!("{stem}-{suffix}.webp"));
            if !candidate.exists() {
                return candidate;
            }
        }
        candidate
    }

    pub fn relative_path(&self, filename: &str) -> PathBuf {
        PathBuf::from("shots").join(filename)
    }
}

/// Link from `from_dir` to `target` using forward slashes. Both paths must be
/// absolute and `target` must live beneath `from_dir`.
pub fn relative_link(from_dir: &Path, target: &Path) -> AppResult<String> {
    let relative = target.strip_prefix(from_dir).map_err(|_| {
        AppError::Invalid(format!(
            "target {} is not inside {}",
            target.display(),
            from_dir.display()
        ))
    })?;
    let segments: Vec<String> = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    if segments.is_empty() {
        return Err(AppError::Invalid("cannot link to a directory".into()));
    }
    Ok(segments.join("/"))
}

/// Filesystem-safe slug. Keeps letters, digits, and dashes; collapses runs.
pub fn sanitize_filename(value: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut last_dash = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            out.push(character.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    let mut result: String = trimmed.chars().take(64).collect();
    if result.is_empty() {
        result = fallback.to_string();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_encodes_second_and_hash() {
        assert_eq!(
            screenshot_filename(35_000, 0x0123_4567_89ab_cdef),
            "shot-000035-0123456789abcdef.webp"
        );
        assert_eq!(
            screenshot_filename(-1, 0),
            "shot-000000-0000000000000000.webp"
        );
    }

    #[test]
    fn planner_avoids_collisions() {
        let dir = tempfile::tempdir().unwrap();
        let planner = ScreenshotPathPlanner::new(dir.path().join("shots"));
        std::fs::create_dir_all(planner.shots_dir()).unwrap();
        let first = planner.plan(10_000, 42);
        assert_eq!(
            first.file_name().unwrap(),
            "shot-000010-000000000000002a.webp"
        );
        std::fs::write(&first, b"x").unwrap();
        let second = planner.plan(10_000, 42);
        assert_eq!(
            second.file_name().unwrap(),
            "shot-000010-000000000000002a-1.webp"
        );
    }

    #[test]
    fn relative_links_use_forward_slashes() {
        let base = Path::new("/vault/meetings/m1");
        let target = Path::new("/vault/meetings/m1/shots/shot-000010-x.webp");
        assert_eq!(
            relative_link(base, target).unwrap(),
            "shots/shot-000010-x.webp"
        );
        assert!(relative_link(base, Path::new("/elsewhere/x.webp")).is_err());
    }

    #[test]
    fn sanitizes_titles() {
        assert_eq!(
            sanitize_filename("Design Review — Q4!", "memo"),
            "design-review-q4"
        );
        assert_eq!(sanitize_filename("  ...  ", "memo"), "memo");
        assert_eq!(sanitize_filename("Café Notes", "memo"), "caf-notes");
        assert!(sanitize_filename(&"a".repeat(200), "memo").len() <= 64);
    }
}
