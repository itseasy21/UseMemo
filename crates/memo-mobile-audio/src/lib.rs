//! Mobile microphone permission and audio-session plumbing.
//!
//! Desktop builds do not need a permission façade: the capture backend prompts
//! on first use and reports a stream error. iOS and Android require an explicit
//! consent flow before the native audio unit is opened, and iOS also requires
//! an active `AVAudioSession` category. This plugin keeps that native work in
//! one place so the app commands and the recording UI stay platform-neutral.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

pub use error::{Error, Result};
pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

#[cfg(desktop)]
use desktop::MobileAudio;
#[cfg(mobile)]
use mobile::MobileAudio;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`].
pub trait MobileAudioExt<R: Runtime> {
    fn mobile_audio(&self) -> &MobileAudio<R>;
}

impl<R: Runtime, T: Manager<R>> MobileAudioExt<R> for T {
    fn mobile_audio(&self) -> &MobileAudio<R> {
        self.state::<MobileAudio<R>>().inner()
    }
}

/// Initialize the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mobile-audio")
        .invoke_handler(tauri::generate_handler![
            commands::microphone_permission,
            commands::request_microphone_permission,
            commands::configure_audio_session,
            commands::deactivate_audio_session,
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let mobile_audio = mobile::init(app, api)?;
            #[cfg(desktop)]
            let mobile_audio = desktop::init(app, api)?;
            app.manage(mobile_audio);
            Ok(())
        })
        .build()
}
