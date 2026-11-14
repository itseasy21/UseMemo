#!/usr/bin/env bash
# Type-check the Windows loopback backend from a non-Windows host.
#
# `wasapi` and the `windows` crate are pure Rust, so a cross-target `cargo
# check`/`clippy` proves the API usage without a Windows machine. The full app
# cannot be cross-checked because `ring` needs the MSVC SDK headers, so this
# probe compiles only the platform module with a stub error type.
#
# This proves compilation, not capture. Running it on Windows is still required.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
module="$root/frontend/src-tauri/src/audio/system/windows.rs"
version="$(sed -n 's/^wasapi = { version = "\([^"]*\)".*/\1/p' "$root/frontend/src-tauri/Cargo.toml")"
target="x86_64-pc-windows-msvc"

if ! rustup target list --installed | grep -qx "$target"; then
  echo "error: $target is not installed. Run: rustup target add $target" >&2
  exit 1
fi

probe="$(mktemp -d "${TMPDIR:-/tmp}/memo-wasapi-check.XXXXXX")"
trap 'rm -rf "$probe"' EXIT
mkdir -p "$probe/src"

cat > "$probe/Cargo.toml" <<EOF
[package]
name = "memo-wasapi-check"
version = "0.0.0"
edition = "2021"

[dependencies]
wasapi = "$version"
EOF

cat > "$probe/src/lib.rs" <<EOF
// Compile-only probe: the real module uses this crate's error type.
#![allow(dead_code)]

mod error {
    #[derive(Debug)]
    pub enum AppError {
        Capture(String),
    }

    impl std::fmt::Display for AppError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                AppError::Capture(message) => f.write_str(message),
            }
        }
    }

    pub type AppResult<T> = Result<T, AppError>;
}

#[path = "$module"]
mod windows;
EOF

(cd "$probe" && cargo clippy --quiet --target "$target" -- -D warnings)
echo "Windows loopback backend type-checks for $target."
