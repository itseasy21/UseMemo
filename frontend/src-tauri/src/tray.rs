use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{
    image::Image,
    menu::{CheckMenuItem, MenuBuilder, MenuItem, SubmenuBuilder},
    tray::TrayIconBuilder,
    App, AppHandle, Emitter, Manager, Wry,
};

use crate::state::AppState;

const TRAY_START_ID: &str = "tray-start-recording";
const TRAY_OPEN_MAIN_ID: &str = "tray-open-main";
const TRAY_OPEN_HUD_ID: &str = "tray-open-hud";
const TRAY_STATUS_ID: &str = "tray-status";
const TRAY_QUIT_ID: &str = "tray-quit";
const TRAY_MIC_PREFIX: &str = "tray-mic:";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayActionPayload {
    pub action: String,
    pub microphone: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayMicrophonePayload {
    pub microphone: String,
    pub label: String,
}

pub struct TrayHandles {
    pub start_item: MenuItem<Wry>,
    pub status_item: MenuItem<Wry>,
    pub selected_mic: Arc<Mutex<String>>,
}

pub fn setup_tray(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let product_name = app
        .try_state::<AppState>()
        .map(|s| s.brand.manifest().product_name.clone())
        .unwrap_or_else(|| "UseMemo".to_string());

    let start_item = MenuItem::with_id(
        app,
        TRAY_START_ID,
        "Start recording",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let open_main_item = MenuItem::with_id(
        app,
        TRAY_OPEN_MAIN_ID,
        format!("Open {product_name}"),
        true,
        None::<&str>,
    )?;
    let open_hud_item = MenuItem::with_id(
        app,
        TRAY_OPEN_HUD_ID,
        "Open Floating HUD",
        true,
        None::<&str>,
    )?;
    let status_item = MenuItem::with_id(
        app,
        TRAY_STATUS_ID,
        "No active recording",
        false,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(
        app,
        TRAY_QUIT_ID,
        format!("Quit {product_name} completely"),
        true,
        Some("CmdOrCtrl+Q"),
    )?;

    let hw_mics = memo_audio_capture::microphone::list_input_devices().unwrap_or_default();
    let mut mic_check_items: Vec<(String, String, CheckMenuItem<Wry>)> = Vec::new();

    let default_id = format!("{TRAY_MIC_PREFIX}default");
    let default_check = CheckMenuItem::with_id(
        app,
        default_id.clone(),
        "System default microphone",
        true,
        true,
        None::<&str>,
    )?;
    mic_check_items.push((default_id, String::new(), default_check.clone()));

    let mut mic_submenu_builder =
        SubmenuBuilder::new(app, "Select microphone").item(&default_check);

    for (idx, device_name) in hw_mics.into_iter().enumerate() {
        let trimmed = device_name.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        let item_id = format!("{TRAY_MIC_PREFIX}{idx}");
        let check_item = CheckMenuItem::with_id(
            app,
            item_id.clone(),
            trimmed.clone(),
            true,
            false,
            None::<&str>,
        )?;
        mic_submenu_builder = mic_submenu_builder.item(&check_item);
        mic_check_items.push((item_id, trimmed, check_item));
    }

    let mic_submenu = mic_submenu_builder.build()?;

    let menu = MenuBuilder::new(app)
        .item(&start_item)
        .separator()
        .item(&open_main_item)
        .item(&open_hud_item)
        .separator()
        .item(&status_item)
        .separator()
        .item(&mic_submenu)
        .item(&quit_item)
        .build()?;

    let selected_mic = Arc::new(Mutex::new(String::new()));
    app.manage(TrayHandles {
        start_item: start_item.clone(),
        status_item: status_item.clone(),
        selected_mic: Arc::clone(&selected_mic),
    });

    let icon = Image::from_bytes(include_bytes!("../icons/tray-Template@2x.png"))
        .or_else(|_| Image::from_bytes(include_bytes!("../icons/32x32.png")))?;

    let mic_items_for_handler = Arc::new(mic_check_items);
    let selected_mic_for_handler = Arc::clone(&selected_mic);

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .icon_as_template(true)
        .tooltip(&product_name)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app_handle, event| {
            let id = event.id().as_ref();
            if id == TRAY_START_ID {
                focus_main_window(app_handle);
                let mic = selected_mic_for_handler
                    .lock()
                    .map(|g| g.clone())
                    .unwrap_or_default();
                let _ = app_handle.emit(
                    "tray:action",
                    TrayActionPayload {
                        action: "start-recording".into(),
                        microphone: mic,
                    },
                );
            } else if id == TRAY_OPEN_MAIN_ID {
                focus_main_window(app_handle);
            } else if id == TRAY_OPEN_HUD_ID {
                if let Some(hud) = app_handle.get_webview_window("hud") {
                    let _ = hud.show();
                    let _ = hud.set_focus();
                }
            } else if id == TRAY_QUIT_ID {
                app_handle.exit(0);
            } else if id.starts_with(TRAY_MIC_PREFIX) {
                let mut chosen_device = String::new();
                for (item_id, device_name, check_item) in mic_items_for_handler.iter() {
                    let is_match = item_id == id;
                    let _ = check_item.set_checked(is_match);
                    if is_match {
                        chosen_device = device_name.clone();
                    }
                }
                if let Ok(mut guard) = selected_mic_for_handler.lock() {
                    *guard = chosen_device.clone();
                }
                let label = if chosen_device.is_empty() {
                    "System default microphone".to_string()
                } else {
                    chosen_device.clone()
                };
                let _ = app_handle.emit(
                    "tray:microphone-changed",
                    TrayMicrophonePayload {
                        microphone: chosen_device,
                        label,
                    },
                );
            }
        })
        .build(app)?;

    Ok(())
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn update_tray_recording_state(app: &AppHandle, active_title: Option<&str>) {
    let Some(handles) = app.try_state::<TrayHandles>() else {
        return;
    };
    match active_title {
        Some(title) => {
            let clean = if title.trim().is_empty() {
                "Active session"
            } else {
                title.trim()
            };
            let _ = handles.start_item.set_text("Open active recording");
            let _ = handles.status_item.set_text(format!("Recording: {clean}"));
        }
        None => {
            let _ = handles.start_item.set_text("Start recording");
            let _ = handles.status_item.set_text("No active recording");
        }
    }
}
