use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::state::AppState;

const SELF_BUNDLE_ID: &str = "org.gnu.usememo";
const FACETIME_DAEMON: &str = "com.apple.avconferenced";
const FACETIME_APP: &str = "com.apple.FaceTime";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioClient {
    reported_id: Option<String>,
    app_id: Option<String>,
    input_active: bool,
    output_active: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignalSnapshot {
    supported: bool,
    backend: String,
    clients: Vec<AudioClient>,
    running_apps: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallDetectionStatus {
    pub supported: bool,
    pub enabled: bool,
    pub backend: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CallDetectedPayload {
    call_id: String,
    app_id: String,
    app_name: String,
    confidence: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CallEndedPayload {
    call_id: String,
    app_id: String,
    app_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AppKind {
    Native,
    Browser,
}

#[derive(Debug, Clone)]
struct CallApp {
    id: &'static str,
    name: &'static str,
    kind: AppKind,
}

#[derive(Debug)]
enum Phase {
    Candidate { since: Instant },
    Active { call_id: String },
    Ending { call_id: String, off_at: Instant },
}

pub struct CallDetectionState {
    enabled: AtomicBool,
    disabled_apps: RwLock<HashSet<String>>,
    settings_path: PathBuf,
}

impl CallDetectionState {
    pub fn load(settings_path: PathBuf) -> Self {
        let settings = std::fs::read(&settings_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<PersistedSettings>(&bytes).ok())
            .unwrap_or_default();
        Self {
            enabled: AtomicBool::new(settings.enabled),
            disabled_apps: RwLock::new(settings.disabled_apps),
            settings_path,
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    pub async fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        self.enabled.store(enabled, Ordering::Release);
        self.persist().await
    }

    pub async fn set_app_enabled(&self, app_id: String, enabled: bool) -> Result<(), String> {
        let mut disabled = self.disabled_apps.write().await;
        if enabled {
            disabled.remove(&app_id);
        } else {
            disabled.insert(app_id);
        }
        drop(disabled);
        self.persist().await
    }

    async fn persist(&self) -> Result<(), String> {
        let settings = PersistedSettings {
            enabled: self.enabled(),
            disabled_apps: self.disabled_apps.read().await.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
        std::fs::write(&self.settings_path, bytes).map_err(|error| error.to_string())
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSettings {
    enabled: bool,
    disabled_apps: HashSet<String>,
}

fn classify(bundle_id: &str) -> Option<CallApp> {
    let rules: &[(&[&str], CallApp)] = &[
        (
            &["us.zoom.xos"],
            CallApp {
                id: "zoom",
                name: "Zoom",
                kind: AppKind::Native,
            },
        ),
        (
            &["com.microsoft.teams2", "com.microsoft.teams"],
            CallApp {
                id: "teams",
                name: "Microsoft Teams",
                kind: AppKind::Native,
            },
        ),
        (
            &["net.whatsapp.WhatsApp", "desktop.WhatsApp"],
            CallApp {
                id: "whatsapp",
                name: "WhatsApp",
                kind: AppKind::Native,
            },
        ),
        (
            &["com.apple.FaceTime"],
            CallApp {
                id: "facetime",
                name: "FaceTime",
                kind: AppKind::Native,
            },
        ),
        (
            &["com.tinyspeck.slackmacgap"],
            CallApp {
                id: "slack",
                name: "Slack",
                kind: AppKind::Native,
            },
        ),
        (
            &["com.hnc.Discord"],
            CallApp {
                id: "discord",
                name: "Discord",
                kind: AppKind::Native,
            },
        ),
        (
            &["com.google.Chrome"],
            CallApp {
                id: "browser:chrome",
                name: "Google Chrome",
                kind: AppKind::Browser,
            },
        ),
        (
            &["com.microsoft.edgemac"],
            CallApp {
                id: "browser:edge",
                name: "Microsoft Edge",
                kind: AppKind::Browser,
            },
        ),
        (
            &["com.brave.Browser"],
            CallApp {
                id: "browser:brave",
                name: "Brave",
                kind: AppKind::Browser,
            },
        ),
        (
            &["company.thebrowser.Browser"],
            CallApp {
                id: "browser:arc",
                name: "Arc",
                kind: AppKind::Browser,
            },
        ),
        (
            &["org.mozilla.firefox"],
            CallApp {
                id: "browser:firefox",
                name: "Firefox",
                kind: AppKind::Browser,
            },
        ),
        (
            &["com.apple.Safari", "com.apple.WebKit.GPU"],
            CallApp {
                id: "browser:safari",
                name: "Safari or a web-view app",
                kind: AppKind::Browser,
            },
        ),
    ];
    rules.iter().find_map(|(prefixes, app)| {
        prefixes
            .iter()
            .any(|prefix| bundle_id == *prefix || bundle_id.starts_with(&format!("{prefix}.")))
            .then(|| app.clone())
    })
}

fn active_apps(snapshot: &SignalSnapshot) -> HashMap<&'static str, (CallApp, bool)> {
    let running: HashSet<&str> = snapshot.running_apps.iter().map(String::as_str).collect();
    let mut active = HashMap::new();
    for client in snapshot.clients.iter().filter(|client| client.input_active) {
        let ids = [client.app_id.as_deref(), client.reported_id.as_deref()];
        if ids.into_iter().flatten().any(|id| id == SELF_BUNDLE_ID) {
            continue;
        }
        let app = if ids.into_iter().flatten().any(|id| id == FACETIME_DAEMON)
            && running.contains(FACETIME_APP)
        {
            classify(FACETIME_APP)
        } else {
            client
                .app_id
                .as_deref()
                .and_then(classify)
                .or_else(|| client.reported_id.as_deref().and_then(classify))
        };
        if let Some(app) = app {
            let output = snapshot.clients.iter().any(|candidate| {
                candidate.output_active
                    && [
                        candidate.app_id.as_deref(),
                        candidate.reported_id.as_deref(),
                    ]
                    .into_iter()
                    .flatten()
                    .filter_map(classify)
                    .any(|candidate_app| candidate_app.id == app.id)
            });
            active.insert(app.id, (app, output));
        }
    }
    active
}

async fn run_detector(app: AppHandle, state: Arc<CallDetectionState>) {
    let mut phases: HashMap<&'static str, Phase> = HashMap::new();
    let mut ticker = tokio::time::interval(Duration::from_secs(3));
    loop {
        ticker.tick().await;
        if !state.enabled() {
            phases.clear();
            continue;
        }
        if app
            .try_state::<AppState>()
            .is_some_and(|app_state| app_state.is_recording.load(Ordering::Acquire))
        {
            phases.clear();
            continue;
        }
        let snapshot = match tokio::task::spawn_blocking(platform_snapshot).await {
            Ok(Ok(snapshot)) if snapshot.supported => snapshot,
            Ok(Ok(_)) => {
                phases.clear();
                continue;
            }
            Ok(Err(error)) => {
                tracing::debug!(error = %error, "call detection snapshot failed");
                continue;
            }
            Err(error) => {
                tracing::debug!(error = %error, "call detection snapshot task failed");
                continue;
            }
        };
        let active = active_apps(&snapshot);
        let disabled = state.disabled_apps.read().await.clone();
        let now = Instant::now();
        let ids: HashSet<&'static str> = phases
            .keys()
            .copied()
            .chain(active.keys().copied())
            .collect();
        for id in ids {
            if disabled.contains(id) {
                phases.remove(id);
                continue;
            }
            let current = phases.remove(id);
            let live = active.get(id);
            match (current, live) {
                (None, Some(_)) => {
                    phases.insert(id, Phase::Candidate { since: now });
                }
                (Some(Phase::Candidate { since }), Some((call_app, output)))
                    if now.duration_since(since)
                        >= match call_app.kind {
                            AppKind::Native => Duration::from_secs(3),
                            AppKind::Browser => Duration::from_secs(8),
                        } =>
                {
                    let call_id = Uuid::now_v7().to_string();
                    let confidence = match (call_app.kind, output) {
                        (AppKind::Native, true) => 0.95,
                        (AppKind::Native, false) => 0.85,
                        (AppKind::Browser, true) => 0.6,
                        (AppKind::Browser, false) => 0.4,
                    };
                    show_prompt_window(&app);
                    let _ = app.emit(
                        "call-detect://started",
                        CallDetectedPayload {
                            call_id: call_id.clone(),
                            app_id: call_app.id.into(),
                            app_name: call_app.name.into(),
                            confidence,
                        },
                    );
                    phases.insert(id, Phase::Active { call_id });
                }
                (Some(Phase::Candidate { since }), Some(_)) => {
                    phases.insert(id, Phase::Candidate { since });
                }
                (Some(Phase::Active { call_id }), Some(_)) => {
                    phases.insert(id, Phase::Active { call_id });
                }
                (Some(Phase::Active { call_id }), None) => {
                    phases.insert(
                        id,
                        Phase::Ending {
                            call_id,
                            off_at: now,
                        },
                    );
                }
                (Some(Phase::Ending { call_id, .. }), Some(_)) => {
                    phases.insert(id, Phase::Active { call_id });
                }
                (Some(Phase::Ending { call_id, off_at }), None)
                    if now.duration_since(off_at) >= Duration::from_secs(15) =>
                {
                    let call_app = classify_by_id(id);
                    if let Some(call_app) = call_app {
                        let _ = app.emit(
                            "call-detect://ended",
                            CallEndedPayload {
                                call_id,
                                app_id: call_app.id.into(),
                                app_name: call_app.name.into(),
                            },
                        );
                    }
                }
                (Some(Phase::Ending { call_id, off_at }), None) => {
                    phases.insert(id, Phase::Ending { call_id, off_at });
                }
                _ => {}
            }
        }
    }
}

fn show_prompt_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("hud") else {
        return;
    };
    let _ = window.set_size(tauri::LogicalSize::new(360.0, 180.0));
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let width = (360.0 * scale) as i32;
        let margin = (20.0 * scale) as i32;
        let x = monitor.position().x + size.width as i32 - width - margin;
        let y = monitor.position().y + margin;
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
    let _ = window.show();
}

fn classify_by_id(id: &str) -> Option<CallApp> {
    [
        "us.zoom.xos",
        "com.microsoft.teams2",
        "net.whatsapp.WhatsApp",
        "com.apple.FaceTime",
        "com.tinyspeck.slackmacgap",
        "com.hnc.Discord",
        "com.google.Chrome",
        "com.microsoft.edgemac",
        "com.brave.Browser",
        "company.thebrowser.Browser",
        "org.mozilla.firefox",
        "com.apple.Safari",
    ]
    .into_iter()
    .filter_map(classify)
    .find(|app| app.id == id)
}

pub fn start(app: &AppHandle, state: Arc<CallDetectionState>) {
    let app = app.clone();
    tauri::async_runtime::spawn(run_detector(app, state));
}

pub fn status(state: &CallDetectionState) -> CallDetectionStatus {
    match platform_snapshot() {
        Ok(snapshot) => CallDetectionStatus {
            supported: snapshot.supported,
            enabled: state.enabled(),
            backend: snapshot.backend,
            detail: if snapshot.supported {
                "Detects known call apps using the microphone without reading audio.".into()
            } else if cfg!(target_os = "macos") {
                "App-level meeting detection requires macOS 14 or later.".into()
            } else {
                "Meeting detection is not implemented on this platform yet.".into()
            },
        },
        Err(error) => CallDetectionStatus {
            supported: false,
            enabled: state.enabled(),
            backend: "unavailable".into(),
            detail: error,
        },
    }
}

#[cfg(target_os = "macos")]
fn platform_snapshot() -> Result<SignalSnapshot, String> {
    use std::ffi::{c_char, CStr};

    unsafe extern "C" {
        fn memo_macos_call_signal_snapshot(
            out_json: *mut *mut c_char,
            out_error: *mut *mut c_char,
        ) -> i32;
        fn memo_macos_free_string(value: *mut c_char);
    }

    let mut json = std::ptr::null_mut();
    let mut error = std::ptr::null_mut();
    let status = unsafe { memo_macos_call_signal_snapshot(&mut json, &mut error) };
    let message = if error.is_null() {
        None
    } else {
        let message = unsafe { CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned();
        unsafe { memo_macos_free_string(error) };
        Some(message)
    };
    if status != 0 {
        return Err(message.unwrap_or_else(|| "CoreAudio meeting detection failed".into()));
    }
    if json.is_null() {
        return Err("CoreAudio meeting detection returned no data".into());
    }
    let payload = unsafe { CStr::from_ptr(json) }
        .to_string_lossy()
        .into_owned();
    unsafe { memo_macos_free_string(json) };
    serde_json::from_str(&payload).map_err(|error| error.to_string())
}

#[cfg(not(target_os = "macos"))]
fn platform_snapshot() -> Result<SignalSnapshot, String> {
    Ok(SignalSnapshot {
        supported: false,
        backend: "unavailable".into(),
        clients: Vec::new(),
        running_apps: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifier_does_not_prefix_match_unrelated_apps() {
        assert!(classify("com.google.Chrome.helper").is_some());
        assert!(classify("com.google.Chromebook").is_none());
    }

    #[test]
    fn facetime_daemon_requires_facetime_to_be_running() {
        let snapshot = SignalSnapshot {
            supported: true,
            backend: "test".into(),
            clients: vec![AudioClient {
                reported_id: Some(FACETIME_DAEMON.into()),
                app_id: None,
                input_active: true,
                output_active: false,
            }],
            running_apps: vec![],
        };
        assert!(active_apps(&snapshot).is_empty());
    }
}
