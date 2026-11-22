//! Two-voice diarization acceptance on macOS.
//!
//! Builds a turn-taking conversation from two distinct system voices, plays it
//! through the normal output device, captures the loopback with
//! ScreenCaptureKit, resamples the archive to 16 kHz, and runs the diarizer.
//!
//! This is synthesized speech, not a human meeting: it exercises real speech
//! formants and the production capture path, but not a real recording. It is
//! opt-in because it needs Screen Recording permission and an audible output
//! device:
//!
//! ```sh
//! MEMO_DIARIZATION_E2E=1 cargo test -p use-memo \
//!   --test diarization_acceptance -- --nocapture
//! ```
//!
//! If Screen Recording is missing the test skips with instructions instead of
//! failing a machine that cannot capture yet.

#![cfg(all(feature = "system-audio", target_os = "macos"))]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use memo_audio_capture::wav::{read_wav, WavSpec, WavWriter};
use memo_audio_capture::SincResampler;
use memo_diarize::{diarize, DiarizationConfig};
use use_memo_lib::audio::system::SystemAudioCapture;

const RATE: u32 = 48_000;
const VOICE_A: &str = "Samantha";
const VOICE_B: &str = "Fred";
const GAP_MS: usize = 700;

const LINES_A: [&str; 2] = [
    "Let's review the quarterly launch plan and confirm the beta date before we share it with the team.",
    "I can send the updated schedule to everyone this afternoon once the numbers are verified.",
];
const LINES_B: [&str; 2] = [
    "I think we should delay the beta by two weeks and tell the customers on Friday morning.",
    "That works for me, and I will ask support to prepare a short note for the early access group.",
];

#[test]
#[ignore = "requires macOS Screen Recording permission and audible speaker output; run with MEMO_DIARIZATION_E2E=1 cargo test -- --ignored"]
fn two_voices_are_separated_from_loopback_audio() {
    if std::env::var("MEMO_DIARIZATION_E2E").as_deref() != Ok("1") {
        eprintln!(
            "SKIP diarization acceptance: set MEMO_DIARIZATION_E2E=1 and grant Screen Recording"
        );
        return;
    }
    for voice in [VOICE_A, VOICE_B] {
        if !voice_available(voice) {
            eprintln!("SKIP diarization acceptance: the `{voice}` system voice is not installed");
            return;
        }
    }

    let dir = std::env::temp_dir().join(format!("memo-diarization-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let conversation = match build_conversation(&dir) {
        Ok(path) => path,
        Err(message) => {
            eprintln!("SKIP diarization acceptance: {message}");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
    };
    if let Ok(path) = std::env::var("MEMO_DIARIZATION_DUMP_CONVERSATION") {
        let _ = std::fs::copy(&conversation, path);
    }

    let capture = match SystemAudioCapture::start() {
        Ok(capture) => capture,
        Err(error) => {
            let message = error.to_string();
            if message.contains("Screen Recording") {
                eprintln!(
                    "SKIP diarization acceptance: {message}\n\
                     Grant Screen Recording to the terminal or test host, then rerun."
                );
                let _ = std::fs::remove_dir_all(&dir);
                return;
            }
            panic!("system audio did not start: {message}");
        }
    };
    let mut player = match Command::new("afplay").arg(&conversation).spawn() {
        Ok(player) => player,
        Err(error) => {
            eprintln!("SKIP diarization acceptance: cannot run afplay: {error}");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
    };

    let deadline = Instant::now() + Duration::from_secs(45);
    let mut captured = Vec::new();
    let mut done_at: Option<Instant> = None;
    while Instant::now() < deadline {
        for block in capture.drain(64) {
            captured.extend_from_slice(&block);
        }
        if done_at.is_none() && player.try_wait().ok().flatten().is_some() {
            // Let the last queued block arrive before closing the tap.
            done_at = Some(Instant::now() + Duration::from_millis(800));
        }
        if done_at.is_some_and(|tail| Instant::now() >= tail) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = player.kill();
    let _ = player.wait();
    for block in capture.drain(256) {
        captured.extend_from_slice(&block);
    }
    let _ = std::fs::remove_dir_all(&dir);

    assert!(!captured.is_empty(), "ScreenCaptureKit delivered no audio");
    let peak = captured
        .iter()
        .fold(0.0f32, |peak, sample| peak.max(sample.abs()));
    assert!(
        peak > 0.01,
        "loopback captured {} samples but only silence (peak {peak:.6}); \
         check the output volume",
        captured.len()
    );

    let mut mono16 = Vec::new();
    let mut resampler = SincResampler::new(capture.sample_rate(), 16_000).unwrap();
    resampler.process(&captured, &mut mono16);
    resampler.finish(&mut mono16);

    // Optional forensic copy for threshold work: the composer already deletes
    // the generated clips, so keep the exact archive the diarizer saw.
    if let Ok(path) = std::env::var("MEMO_DIARIZATION_DUMP") {
        let mut writer = WavWriter::create(
            Path::new(&path),
            WavSpec::new(16_000, 1).expect("16 kHz mono is a valid wav spec"),
        )
        .expect("cannot create the diarization dump");
        writer.write_samples(&mono16).unwrap();
        writer.finalize().unwrap();
    }

    let levels: Vec<f32> = mono16
        .chunks(16_000)
        .map(|second| {
            let mean_square = second.iter().map(|sample| sample * sample).sum::<f32>()
                / second.len().max(1) as f32;
            10.0 * (mean_square + 1e-12).log10()
        })
        .collect();
    eprintln!(
        "capture: {} samples, per-second dB: {levels:?}",
        mono16.len()
    );

    let result = diarize(&mono16, &DiarizationConfig::default());
    let turns: Vec<_> = result
        .turns
        .iter()
        .map(|turn| (turn.start_ms, turn.end_ms, turn.speaker))
        .collect();
    eprintln!(
        "diarization: speakers={} windows={} speech_ms={} turns={turns:?}",
        result.speakers, result.windows, result.speech_ms
    );

    assert_eq!(result.speakers, 2, "expected two voices, turns: {turns:?}");
    assert!(
        result.turns.len() >= 4,
        "expected one turn per spoken line, turns: {turns:?}"
    );
    assert_eq!(
        result.turns[0].speaker, 1,
        "labels are numbered by first appearance: {turns:?}"
    );
    for speaker in [1, 2] {
        let count = result
            .turns
            .iter()
            .filter(|turn| turn.speaker == speaker)
            .count();
        assert!(
            count >= 2,
            "Speaker {speaker} should own two lines, turns: {turns:?}"
        );
    }
    assert!(
        result.speech_ms > 15_000,
        "expected more than 15 s of speech, got {} ms",
        result.speech_ms
    );
}

fn voice_available(voice: &str) -> bool {
    Command::new("say")
        .args(["-v", "?"])
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).contains(voice))
        .unwrap_or(false)
}

/// Build `A, B, A, B` with short pauses at 48 kHz mono, matching what the
/// system tap delivers before the archive resampler.
fn build_conversation(dir: &Path) -> Result<PathBuf, String> {
    let mut audio = silence(800);
    for index in 0..LINES_A.len() {
        audio.extend(synthesize(dir, VOICE_A, LINES_A[index], index)?);
        audio.extend(silence(GAP_MS));
        audio.extend(synthesize(dir, VOICE_B, LINES_B[index], index)?);
        audio.extend(silence(GAP_MS));
    }

    let path = dir.join("conversation.wav");
    let mut writer = WavWriter::create(
        &path,
        WavSpec::new(RATE, 1).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    writer
        .write_samples(&audio)
        .map_err(|error| error.to_string())?;
    writer.finalize().map_err(|error| error.to_string())?;
    Ok(path)
}

fn synthesize(dir: &Path, voice: &str, line: &str, index: usize) -> Result<Vec<f32>, String> {
    let path = dir.join(format!("{voice}-{index}.wav"));
    let output = Command::new("say")
        .args(["-v", voice, "-o"])
        .arg(&path)
        .args(["--data-format=LEI16@48000", line])
        .output()
        .map_err(|error| format!("cannot run say: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "say failed for {voice}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let audio = read_wav(&path).map_err(|error| error.to_string())?;
    if audio.sample_rate != RATE || audio.channels != 1 {
        return Err(format!(
            "say produced {} Hz / {} channels, expected {RATE} Hz mono",
            audio.sample_rate, audio.channels
        ));
    }
    Ok(audio.samples)
}

fn silence(ms: usize) -> Vec<f32> {
    vec![0.0; (RATE as usize * ms) / 1_000]
}
