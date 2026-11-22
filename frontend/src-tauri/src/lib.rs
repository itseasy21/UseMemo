pub mod asr;
pub mod audio;
pub mod brand;
pub mod commands;
pub mod error;
pub mod events;
pub mod export;
pub mod generated_brand;
pub mod logging;
pub mod model_registry;
pub mod models;
pub mod screenshot;
pub mod state;
pub mod storage;
pub mod synthesis;
#[cfg(desktop)]
pub mod tray;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(memo_mobile_audio::init())
        .setup(|app| {
            #[cfg(target_os = "android")]
            {
                if std::env::var_os("XDG_DATA_HOME").is_none() {
                    if let Ok(path) = app.path().app_data_dir() {
                        std::env::set_var("XDG_DATA_HOME", path);
                    }
                }
                if std::env::var_os("XDG_CACHE_HOME").is_none() {
                    if let Ok(path) = app.path().app_cache_dir() {
                        std::env::set_var("XDG_CACHE_HOME", path);
                    }
                }
            }
            let (brand, capture, synthesis) = state::production_state_parts()?;
            let state = tauri::async_runtime::block_on(state::AppState::initialize(
                brand, capture, synthesis,
            ))?;
            // Explicitly authorize the resolved brand media directory for the
            // Tauri `asset://` protocol so recorded WAVs and WebP screenshots
            // never fail with 403 when `storageDirName` differs from `identifier`.
            if let Err(error) = app
                .asset_protocol_scope()
                .allow_directory(&state.paths.media_dir, true)
            {
                tracing::warn!(
                    media_dir = %state.paths.media_dir.display(),
                    error = %error,
                    "could not register runtime asset_protocol_scope directory"
                );
            }
            app.manage(state);
            #[cfg(desktop)]
            if let Err(error) = tray::setup_tray(app) {
                tracing::warn!(error = %error, "could not initialize system tray menu");
            }
            Ok(())
        })
        .on_window_event(|_window, _event| {
            #[cfg(target_os = "macos")]
            if _window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = _event {
                    api.prevent_close();
                    let _ = _window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::brand::get_brand_config,
            commands::brand::get_brand_manifest,
            commands::diagnostics::get_diagnostics_summary,
            commands::diagnostics::export_diagnostics,
            commands::meetings::create_meeting,
            commands::meetings::update_meeting,
            commands::meetings::list_meetings,
            commands::meetings::get_meeting,
            commands::meetings::finish_meeting,
            commands::meetings::delete_meeting,
            commands::meetings::discard_failed_meeting,
            commands::meetings::set_meeting_starred,
            commands::meetings::set_meeting_tags,
            commands::meetings::get_meeting_tags,
            commands::meetings::list_all_tags,
            commands::meetings::set_screenshot_interval,
            commands::meetings::list_capture_targets,
            commands::meetings::set_capture_target,
            commands::meetings::start_recording,
            commands::meetings::pause_recording,
            commands::meetings::resume_recording,
            commands::meetings::stop_recording,
            commands::meetings::recording_status,
            commands::meetings::audio_capabilities,
            commands::meetings::request_system_audio_access,
            commands::mobile::microphone_permission,
            commands::mobile::request_microphone_permission,
            commands::mobile::configure_audio_session,
            commands::mobile::deactivate_audio_session,
            commands::notes::save_notes,
            commands::notes::list_notes,
            commands::transcript::transcribe_meeting,
            commands::transcript::cancel_transcription,
            commands::transcript::append_transcript,
            commands::transcript::list_transcript,
            commands::transcript::update_transcript_segment,
            commands::transcript::list_speakers,
            commands::transcript::upsert_speaker,
            commands::transcript::rename_speaker,
            commands::screenshots::list_screenshots,
            commands::screenshots::delete_screenshot,
            commands::screenshots::capture_screenshot,
            commands::screenshots::update_screenshot_ocr,
            commands::screenshots::analyze_screenshot_ocr,
            commands::synthesis::synthesize_meeting,
            commands::synthesis::list_synthesis,
            commands::synthesis::create_synthesis_item,
            commands::synthesis::update_synthesis_item,
            commands::synthesis::synthesis_context_preview,
            commands::synthesis::ask_assistant,
            commands::synthesis::export_meeting,
            commands::search::search,
            commands::search::rebuild_search_index,
            commands::search::create_folder,
            commands::search::rename_folder,
            commands::search::delete_folder,
            commands::search::list_folders,
            commands::models::list_models,
            commands::models::probe_hardware,
            commands::models::download_model,
            commands::models::cancel_model_download,
            commands::models::delete_model,
            commands::models::unload_models,
        ])
        .run(tauri::generate_context!());

    if let Err(error) = result {
        tracing::error!(error = %error, "Tauri application exited with error");
        eprintln!("Tauri application error: {error}");
    }
}
