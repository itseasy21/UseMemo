#!/usr/bin/env bash
# Phase 0 host/hardware probe.
# Writes a machine-readable build-env.json at the repository root and prints a summary.
# No network access, no package installation, no persistent daemon.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${ROOT}/build-env.json"
if [[ "${1:-}" == "--stdout" ]]; then
  OUT="/dev/stdout"
fi

json_escape() {
  printf '%s' "${1:-}" | tr '\n' ' ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/ /g'
}

version_of() {
  local cmd="$1"
  shift
  if command -v "$cmd" >/dev/null 2>&1; then
    "$cmd" "$@" 2>/dev/null | head -1 | tr -d '\r'
  else
    printf ''
  fi
}

OS_NAME="$(uname -s)"
KERNEL="$(uname -r)"
ARCH="$(uname -m)"
DISPLAY_SERVER="unknown"
OS_VERSION="$(uname -v)"
CPU_MODEL="unknown"
CPU_CORES=0
RAM_BYTES=0

case "$OS_NAME" in
  Darwin)
    DISPLAY_SERVER="quartz"
    OS_VERSION="$(sw_vers -productVersion 2>/dev/null || uname -r)"
    CPU_MODEL="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo 'Apple Silicon')"
    CPU_CORES="$(sysctl -n hw.ncpu 2>/dev/null || echo 0)"
    RAM_BYTES="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
    ;;
  Linux)
    DISPLAY_SERVER="${XDG_SESSION_TYPE:-unknown}"
    if [[ -f /etc/os-release ]]; then
      # shellcheck disable=SC1091
      OS_VERSION="$(. /etc/os-release && echo "${PRETTY_NAME:-$NAME}")"
    fi
    CPU_MODEL="$(lscpu 2>/dev/null | awk -F': +' '/Model name/{print $2; exit}' || echo unknown)"
    CPU_CORES="$(nproc 2>/dev/null || echo 0)"
    RAM_BYTES="$(awk '/MemTotal/{print $2 * 1024; exit}' /proc/meminfo 2>/dev/null || echo 0)"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    DISPLAY_SERVER="win32"
    OS_VERSION="$(cmd //c ver 2>/dev/null | tr -d '\r' || uname -v)"
    CPU_MODEL="$(wmic cpu get name 2>/dev/null | sed -n '2p' | tr -d '\r' || echo unknown)"
    CPU_CORES="${NUMBER_OF_PROCESSORS:-0}"
    RAM_BYTES="$(wmic computersystem get TotalPhysicalMemory 2>/dev/null | sed -n '2p' | tr -d '\r' || echo 0)"
    ;;
esac

RAM_BYTES="${RAM_BYTES//[!0-9]/}"
[[ -z "$RAM_BYTES" ]] && RAM_BYTES=0
RAM_GB="$(awk -v bytes="$RAM_BYTES" 'BEGIN { if (bytes > 0) printf "%.1f", bytes / 1073741824; else print "0.0" }')"

TIER="low"
TIER_REASON="< 8 GB RAM"
if awk -v gb="$RAM_GB" 'BEGIN { exit !(gb >= 16) }'; then
  TIER="high"
  TIER_REASON=">= 16 GB RAM"
elif awk -v gb="$RAM_GB" 'BEGIN { exit !(gb >= 8) }'; then
  TIER="mid"
  TIER_REASON="8–15.9 GB RAM"
fi

ASR_REPO="litert-community/whisper-tiny"
ASR_FILE="whisper_tiny_30s_i8.litertlm"
ASR_BYTES=43830477
SLM_REPO="litert-community/gemma-4-E2B-it-litert-lm"
SLM_FILE="gemma-4-E2B-it.litertlm"
SLM_BYTES=2770255085
if [[ "$TIER" == "mid" || "$TIER" == "high" ]]; then
  ASR_REPO="litert-community/parakeet-tdt-0.6b-v3"
  ASR_FILE="parakeet_tdt_0.6b_v3_5s_i8_stateful.litertlm"
  ASR_BYTES=644874240
fi
if [[ "$TIER" == "high" ]]; then
  SLM_REPO="litert-community/gemma-4-E4B-it-litert-lm"
  SLM_FILE="gemma-4-E4B-it.litertlm"
  SLM_BYTES=3554007449
fi

KEEP_ASR_WARM="false"
if awk -v gb="$RAM_GB" 'BEGIN { exit !(gb >= 12) }'; then
  KEEP_ASR_WARM="true"
fi

GPU_MODEL="unknown"
METAL="false"
VULKAN="false"
OPENCL="false"
NPU="unknown"
AUDIO_BACKENDS=""
SCK="false"
COREAUDIO="false"
PIPEWIRE="false"
PULSEAUDIO="false"
WASAPI="false"

case "$OS_NAME" in
  Darwin)
    GPU_MODEL="$(system_profiler SPDisplaysDataType 2>/dev/null | awk -F': ' '/Chipset Model:/{print $2; exit}')"
    [[ -z "$GPU_MODEL" ]] && GPU_MODEL="unknown"
    if system_profiler SPDisplaysDataType 2>/dev/null | grep -qi "Metal"; then METAL="true"; fi
    if [[ "$ARCH" == "arm64" ]]; then NPU="apple-neural-engine"; fi
    MAJOR_VERSION="${OS_VERSION%%.*}"
    if [[ "$MAJOR_VERSION" =~ ^[0-9]+$ ]] && (( MAJOR_VERSION >= 13 )); then SCK="true"; fi
    COREAUDIO="true"
    AUDIO_BACKENDS="coreaudio"
    [[ "$SCK" == "true" ]] && AUDIO_BACKENDS="coreaudio,screencapturekit"
    ;;
  Linux)
    GPU_MODEL="$(lspci 2>/dev/null | awk -F': ' '/VGA compatible controller|3D controller/{print $2; exit}' || echo unknown)"
    [[ -z "$GPU_MODEL" ]] && GPU_MODEL="unknown"
    command -v vulkaninfo >/dev/null 2>&1 && VULKAN="true"
    command -v clinfo >/dev/null 2>&1 && OPENCL="true"
    command -v pw-cli >/dev/null 2>&1 && PIPEWIRE="true"
    command -v pactl >/dev/null 2>&1 && PULSEAUDIO="true"
    AUDIO_BACKENDS="alsa"
    [[ "$PIPEWIRE" == "true" ]] && AUDIO_BACKENDS="alsa,pipewire"
    [[ "$PULSEAUDIO" == "true" ]] && AUDIO_BACKENDS="${AUDIO_BACKENDS},pulseaudio"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    GPU_MODEL="$(wmic path win32_VideoController get name 2>/dev/null | sed -n '2p' | tr -d '\r' || echo unknown)"
    WASAPI="true"
    AUDIO_BACKENDS="wasapi"
    ;;
esac

NODE_VERSION="$(version_of node --version)"
PNPM_VERSION="$(version_of pnpm --version)"
RUSTC_VERSION="$(version_of rustc --version)"
CARGO_VERSION="$(version_of cargo --version)"
CMAKE_VERSION="$(version_of cmake --version)"
PROTOC_VERSION="$(version_of protoc --version)"
FFMPEG_VERSION="$(version_of ffmpeg -version)"
BAZEL_VERSION="$(version_of bazel --version)"
XCODE_PATH=""
XCODE_VERSION=""
if command -v xcodebuild >/dev/null 2>&1; then
  XCODE_PATH="$(xcode-select -p 2>/dev/null || true)"
  XCODE_VERSION="$(xcodebuild -version 2>/dev/null | head -1 || true)"
fi

GENERATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

if [[ "$OUT" == "/dev/stdout" ]]; then
  exec 3>&1
else
  exec 3>/dev/null
fi

cat > "$OUT" <<JSON
{
  "schemaVersion": 1,
  "generatedAt": "$(json_escape "$GENERATED_AT")",
  "host": {
    "os": "$(json_escape "$OS_NAME")",
    "osVersion": "$(json_escape "$OS_VERSION")",
    "kernel": "$(json_escape "$KERNEL")",
    "arch": "$(json_escape "$ARCH")",
    "displayServer": "$(json_escape "$DISPLAY_SERVER")",
    "cpuModel": "$(json_escape "$CPU_MODEL")",
    "cpuCores": ${CPU_CORES:-0},
    "ramBytes": ${RAM_BYTES:-0},
    "ramGb": ${RAM_GB}
  },
  "accelerators": {
    "metal": ${METAL},
    "vulkan": ${VULKAN},
    "opencl": ${OPENCL},
    "xnnpackCpu": true,
    "npu": "$(json_escape "$NPU")",
    "gpuModel": "$(json_escape "$GPU_MODEL")"
  },
  "audio": {
    "backends": "$(json_escape "$AUDIO_BACKENDS")",
    "screenCaptureKit": ${SCK},
    "coreAudio": ${COREAUDIO},
    "pipewire": ${PIPEWIRE},
    "pulseAudio": ${PULSEAUDIO},
    "wasapi": ${WASAPI}
  },
  "toolchain": {
    "node": "$(json_escape "$NODE_VERSION")",
    "pnpm": "$(json_escape "$PNPM_VERSION")",
    "rustc": "$(json_escape "$RUSTC_VERSION")",
    "cargo": "$(json_escape "$CARGO_VERSION")",
    "cmake": "$(json_escape "$CMAKE_VERSION")",
    "protoc": "$(json_escape "$PROTOC_VERSION")",
    "ffmpeg": "$(json_escape "$FFMPEG_VERSION")",
    "bazel": "$(json_escape "$BAZEL_VERSION")",
    "xcodePath": "$(json_escape "$XCODE_PATH")",
    "xcodeVersion": "$(json_escape "$XCODE_VERSION")"
  },
  "recommendation": {
    "tier": "${TIER}",
    "reason": "$(json_escape "$TIER_REASON")",
    "asr": {
      "repo": "$(json_escape "$ASR_REPO")",
      "filename": "$(json_escape "$ASR_FILE")",
      "downloadBytes": ${ASR_BYTES}
    },
    "slm": {
      "repo": "$(json_escape "$SLM_REPO")",
      "filename": "$(json_escape "$SLM_FILE")",
      "downloadBytes": ${SLM_BYTES}
    },
    "keepAsrWarmDuringSynthesis": ${KEEP_ASR_WARM}
  }
}
JSON

if [[ "$OUT" != "/dev/stdout" ]]; then
  cat <<SUMMARY
Host probe written to ${OUT}
  OS:        ${OS_NAME} ${OS_VERSION} (${ARCH})
  CPU:       ${CPU_MODEL} — ${CPU_CORES} cores
  RAM:       ${RAM_GB} GB → tier: ${TIER} (${TIER_REASON})
  GPU:       ${GPU_MODEL} (Metal: ${METAL}, Vulkan: ${VULKAN})
  Audio:     ${AUDIO_BACKENDS}
  Toolchain: node=${NODE_VERSION:-missing} rustc=${RUSTC_VERSION:-missing} cmake=${CMAKE_VERSION:-missing} protoc=${PROTOC_VERSION:-missing} bazel=${BAZEL_VERSION:-missing}
  Models:    ASR ${ASR_FILE}; SLM ${SLM_FILE}
SUMMARY
fi
