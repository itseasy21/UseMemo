const COMMANDS: &[&str] = &[
    "microphone_permission",
    "request_microphone_permission",
    "configure_audio_session",
    "deactivate_audio_session",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
