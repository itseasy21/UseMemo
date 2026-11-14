//! Real system-audio acceptance on macOS.
//!
//! This test opens ScreenCaptureKit, plays a generated tone through the normal
//! output device with `afplay`, and asserts that the loopback saw non-silence.
//! It is intentionally opt-in because it needs both an audible output device
//! and the Screen Recording privacy grant:
//!
//! ```sh
//! MEMO_SYSTEM_AUDIO_E2E=1 cargo test -p use-memo \
//!   --test system_audio_acceptance -- --nocapture
//! ```
//!
//! If the grant is missing, the test skips with instructions instead of
//! failing a machine that cannot legally capture yet. Turn the output volume
//! up: the capture is post-mix, so a muted machine produces a valid but silent
//! archive.

#![cfg(all(feature = "system-audio", target_os = "macos"))]

use std::path::Path;
use std::time::{Duration, Instant};

use memo_audio_capture::{WavSpec, WavWriter};
use use_memo_lib::audio::system::SystemAudioCapture;

#[test]
fn loopback_captures_playback() {
    if std::env::var("MEMO_SYSTEM_AUDIO_E2E").as_deref() != Ok("1") {
        eprintln!(
            "SKIP system-audio acceptance: set MEMO_SYSTEM_AUDIO_E2E=1 and grant Screen Recording"
        );
        return;
    }

    let dir = std::env::temp_dir().join(format!("memo-system-audio-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let tone_path = dir.join("tone.wav");
    write_tone(&tone_path);

    let capture = match SystemAudioCapture::start() {
        Ok(capture) => capture,
        Err(error) => {
            let message = error.to_string();
            if message.contains("Screen Recording") {
                eprintln!(
                    "SKIP system-audio acceptance: {message}\n\
                     Grant Screen Recording to the terminal or test host, then rerun."
                );
                let _ = std::fs::remove_dir_all(&dir);
                return;
            }
            panic!("system audio did not start: {message}");
        }
    };

    let mut player = match std::process::Command::new("afplay").arg(&tone_path).spawn() {
        Ok(player) => player,
        Err(error) => {
            eprintln!("SKIP system-audio acceptance: cannot run afplay: {error}");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
    };

    let deadline = Instant::now() + Duration::from_secs(6);
    let mut peak = 0.0f32;
    let mut blocks = 0usize;
    while Instant::now() < deadline {
        for block in capture.drain(64) {
            blocks += 1;
            for sample in block {
                peak = peak.max(sample.abs());
            }
        }
        if player.try_wait().ok().flatten().is_some() && blocks > 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = player.kill();
    let _ = player.wait();
    let _ = std::fs::remove_file(&tone_path);
    let _ = std::fs::remove_dir_all(&dir);

    assert!(blocks > 0, "ScreenCaptureKit delivered no audio blocks");
    assert!(
        peak > 0.01,
        "loopback captured {blocks} blocks but only silence (peak {peak:.6}); \
         check the output volume and that the tone was audible"
    );
    assert!(
        capture.last_error().is_none(),
        "stream errored: {:?}",
        capture.last_error()
    );
}

fn write_tone(path: &Path) {
    let spec = WavSpec::new(48_000, 1).unwrap();
    let mut writer = WavWriter::create(path, spec).unwrap();
    let mut samples = Vec::with_capacity(48_000 * 4);
    for frame in 0..48_000 * 4 {
        let t = frame as f32 / 48_000.0;
        // 440 Hz at half scale, with short fades so the edges do not click.
        let envelope = (t / 0.02).min(1.0).min(((4.0 - t) / 0.02).clamp(0.0, 1.0));
        samples.push((t * 440.0 * std::f32::consts::TAU).sin() * 0.5 * envelope);
    }
    writer.write_samples(&samples).unwrap();
    writer.finalize().unwrap();
}
