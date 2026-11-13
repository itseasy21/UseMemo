pub mod brand;
pub mod commands;
pub mod error;
pub mod events;
pub mod export;
pub mod generated_brand;
pub mod model_registry;
pub mod models;
pub mod screenshot;
pub mod state;
pub mod storage;
pub mod synthesis;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let (brand, capture, synthesis) = state::production_state_parts()?;
            let state = tauri::async_runtime::block_on(state::AppState::initialize(
                brand, capture, synthesis,
            ))?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::brand::get_brand_config,
            commands::brand::get_brand_manifest,
            commands::meetings::create_meeting,
            commands::meetings::list_meetings,
            commands::meetings::get_meeting,
            commands::meetings::finish_meeting,
            commands::meetings::delete_meeting,
            commands::meetings::set_meeting_starred,
            commands::meetings::set_screenshot_interval,
            commands::meetings::start_recording,
            commands::meetings::stop_recording,
            commands::meetings::recording_status,
            commands::notes::save_notes,
            commands::notes::list_notes,
            commands::transcript::append_transcript,
            commands::transcript::list_transcript,
            commands::transcript::list_speakers,
            commands::transcript::upsert_speaker,
            commands::transcript::rename_speaker,
            commands::screenshots::list_screenshots,
            commands::screenshots::capture_screenshot,
            commands::screenshots::update_screenshot_ocr,
            commands::synthesis::synthesize_meeting,
            commands::synthesis::list_synthesis,
            commands::synthesis::update_synthesis_item,
            commands::synthesis::synthesis_context_preview,
            commands::synthesis::export_meeting,
            commands::search::search,
            commands::search::rebuild_search_index,
            commands::search::create_folder,
            commands::search::list_folders,
            commands::models::list_models,
            commands::models::probe_hardware,
            commands::models::download_model,
            commands::models::delete_model,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Use Memo");
}
