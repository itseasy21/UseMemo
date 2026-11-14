//! Canonical RIFF/WAVE writer for meeting masters.
//!
//! Meetings are long. A writer that buffers the whole take in memory is not an
//! option, and a writer that never patches the header leaves an unplayable file
//! if the process is killed mid-recording. This writer streams samples straight
//! to disk, records the declared sizes in the header, and patches them on
//! [`WavWriter::finalize`]. Dropping the writer without finalizing is treated as
//! a crash: [`WavWriter`]`'s` `Drop` still attempts the patch so the file stays
//! decodable.
//!
//! Only 16-bit little-endian PCM is produced. It is the most portable format for
//! downstream decoders (LiteRT-LM resamples to 16 kHz mono itself), and it keeps
//! a one-hour meeting near 115 MB at 16 kHz.

use std::io::{Seek, SeekFrom, Write};
use std::path::Path;

use crate::error::{AudioError, AudioResult};

/// PCM container formats this writer can emit.
pub const BITS_PER_SAMPLE: u16 = 16;
pub const WAV_HEADER_BYTES: u32 = 44;

/// Largest payload representable by a 32-bit RIFF chunk size.
pub const MAX_DATA_BYTES: u64 = (u32::MAX - WAV_HEADER_BYTES + 8) as u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WavSpec {
    pub sample_rate: u32,
    pub channels: u16,
}

impl WavSpec {
    pub fn new(sample_rate: u32, channels: u16) -> AudioResult<Self> {
        if !(8_000..=192_000).contains(&sample_rate) {
            return Err(AudioError::InvalidConfig(format!(
                "wav sample rate {sample_rate} is outside 8000-192000 Hz"
            )));
        }
        if !(1..=8).contains(&channels) {
            return Err(AudioError::InvalidConfig(format!(
                "wav channel count {channels} is outside 1-8"
            )));
        }
        Ok(Self {
            sample_rate,
            channels,
        })
    }

    pub fn block_align(self) -> u16 {
        self.channels * (BITS_PER_SAMPLE / 8)
    }

    pub fn byte_rate(self) -> u32 {
        self.sample_rate * u32::from(self.block_align())
    }
}

/// Streams interleaved f32 samples to a WAV file as 16-bit PCM.
#[derive(Debug)]
pub struct WavWriter<W: Write + Seek> {
    inner: Option<W>,
    spec: WavSpec,
    data_bytes: u64,
    finalized: bool,
}

impl WavWriter<std::io::BufWriter<std::fs::File>> {
    /// Create (or truncate) `path` and write a provisional header.
    pub fn create(path: &Path, spec: WavSpec) -> AudioResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AudioError::Source(format!("cannot create {parent:?}: {error}"))
            })?;
        }
        let file = std::fs::File::create(path)
            .map_err(|error| AudioError::Source(format!("cannot create {path:?}: {error}")))?;
        Self::new(std::io::BufWriter::new(file), spec)
    }
}

impl<W: Write + Seek> WavWriter<W> {
    pub fn new(inner: W, spec: WavSpec) -> AudioResult<Self> {
        let mut writer = Self {
            inner: Some(inner),
            spec,
            data_bytes: 0,
            finalized: false,
        };
        writer.write_header()?;
        // Flush the provisional header so the file is a valid (empty) WAV even
        // if the process dies before the first sample.
        writer
            .inner_mut()
            .flush()
            .map_err(|error| AudioError::Source(format!("cannot flush wav header: {error}")))?;
        Ok(writer)
    }

    pub fn spec(&self) -> WavSpec {
        self.spec
    }

    /// Bytes of PCM payload written so far, excluding the header.
    pub fn data_bytes(&self) -> u64 {
        self.data_bytes
    }

    pub fn frames(&self) -> u64 {
        self.data_bytes / u64::from(self.spec.block_align())
    }

    /// Duration of the written payload, derived from the sample count rather
    /// than wall-clock time so it matches the audio clock exactly.
    pub fn duration_ms(&self) -> i64 {
        (self.frames() as u128 * 1_000 / self.spec.sample_rate as u128) as i64
    }

    /// Append interleaved samples. Values outside `[-1, 1]` are clipped.
    pub fn write_samples(&mut self, samples: &[f32]) -> AudioResult<()> {
        if samples.is_empty() {
            return Ok(());
        }
        let mut encoded = Vec::with_capacity(samples.len() * 2);
        for sample in samples {
            encoded.extend_from_slice(&encode_pcm16(*sample));
        }
        self.write_encoded(&encoded)
    }

    /// Append samples already encoded as little-endian 16-bit PCM.
    pub fn write_encoded(&mut self, encoded: &[u8]) -> AudioResult<()> {
        if encoded.is_empty() {
            return Ok(());
        }
        let next = self.data_bytes + encoded.len() as u64;
        if next > MAX_DATA_BYTES {
            return Err(AudioError::Source(format!(
                "wav payload exceeds the 4 GiB RIFF limit ({next} bytes)"
            )));
        }
        self.inner_mut()
            .write_all(encoded)
            .map_err(|error| AudioError::Source(format!("cannot write wav payload: {error}")))?;
        self.data_bytes = next;
        Ok(())
    }

    /// Patch the RIFF sizes and flush. Safe to call more than once.
    pub fn finalize(&mut self) -> AudioResult<()> {
        if self.finalized {
            return Ok(());
        }
        self.inner_mut()
            .flush()
            .map_err(|error| AudioError::Source(format!("cannot flush wav payload: {error}")))?;
        self.inner_mut()
            .seek(SeekFrom::Start(0))
            .map_err(|error| AudioError::Source(format!("cannot rewind wav header: {error}")))?;
        self.write_header()?;
        self.inner_mut()
            .flush()
            .map_err(|error| AudioError::Source(format!("cannot flush wav header: {error}")))?;
        self.finalized = true;
        Ok(())
    }

    /// Finalize and hand back the underlying writer.
    pub fn into_inner(mut self) -> AudioResult<W> {
        self.finalize()?;
        // `finalize` left the header in place; take the writer so `Drop` has
        // nothing left to patch.
        self.inner
            .take()
            .ok_or_else(|| AudioError::Source("wav writer was already consumed".to_string()))
    }

    fn inner_mut(&mut self) -> &mut W {
        self.inner
            .as_mut()
            .expect("wav writer is only empty after into_inner")
    }

    fn write_header(&mut self) -> AudioResult<()> {
        let data_len = u32::try_from(self.data_bytes).map_err(|_| {
            AudioError::Source("wav payload exceeds the 4 GiB RIFF limit".to_string())
        })?;
        let riff_len = data_len
            .checked_add(WAV_HEADER_BYTES - 8)
            .ok_or_else(|| AudioError::Source("wav riff size overflow".to_string()))?;

        let mut header = [0u8; WAV_HEADER_BYTES as usize];
        header[0..4].copy_from_slice(b"RIFF");
        header[4..8].copy_from_slice(&riff_len.to_le_bytes());
        header[8..12].copy_from_slice(b"WAVE");
        header[12..16].copy_from_slice(b"fmt ");
        header[16..20].copy_from_slice(&16u32.to_le_bytes());
        header[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
        header[22..24].copy_from_slice(&self.spec.channels.to_le_bytes());
        header[24..28].copy_from_slice(&self.spec.sample_rate.to_le_bytes());
        header[28..32].copy_from_slice(&self.spec.byte_rate().to_le_bytes());
        header[32..34].copy_from_slice(&self.spec.block_align().to_le_bytes());
        header[34..36].copy_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
        header[36..40].copy_from_slice(b"data");
        header[40..44].copy_from_slice(&data_len.to_le_bytes());

        self.inner_mut()
            .write_all(&header)
            .map_err(|error| AudioError::Source(format!("cannot write wav header: {error}")))
    }
}

impl<W: Write + Seek> Drop for WavWriter<W> {
    fn drop(&mut self) {
        if !self.finalized {
            // Best effort: a killed recording should still be playable.
            let _ = self.finalize();
        }
    }
}

/// Convert one f32 sample to little-endian 16-bit PCM with clipping.
pub fn encode_pcm16(sample: f32) -> [u8; 2] {
    let sanitized = if sample.is_finite() { sample } else { 0.0 };
    let scaled = (sanitized.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round();
    (scaled as i16).to_le_bytes()
}

/// Decoded audio, downmixed to mono so ASR never sees interleaved frames.
#[derive(Debug, Clone, PartialEq)]
pub struct WavAudio {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
}

/// Read a RIFF/WAVE file produced by [`WavWriter`] (or any conforming encoder).
///
/// Supports 16-bit integer and 32-bit float PCM; anything else is rejected
/// rather than silently misinterpreted. Unknown chunks (LIST, fact, bext) are
/// skipped, which covers files written by other tools.
pub fn read_wav(path: &Path) -> AudioResult<WavAudio> {
    let bytes = std::fs::read(path)
        .map_err(|error| AudioError::Source(format!("cannot read {path:?}: {error}")))?;
    read_wav_bytes(&bytes)
}

pub fn read_wav_bytes(bytes: &[u8]) -> AudioResult<WavAudio> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(AudioError::InvalidConfig(
            "not a RIFF/WAVE file".to_string(),
        ));
    }
    let mut cursor = 12usize;
    let mut spec: Option<(u16, u16, u32, u16)> = None;
    let mut pcm: Option<&[u8]> = None;

    while cursor + 8 <= bytes.len() {
        let id = &bytes[cursor..cursor + 4];
        let size = u32::from_le_bytes(
            bytes[cursor + 4..cursor + 8]
                .try_into()
                .map_err(|_| AudioError::InvalidConfig("truncated wav chunk".to_string()))?,
        ) as usize;
        let body_start = cursor + 8;
        let body_end = body_start
            .checked_add(size)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| AudioError::InvalidConfig("wav chunk overruns the file".to_string()))?;
        let body = &bytes[body_start..body_end];
        match id {
            b"fmt " => {
                if body.len() < 16 {
                    return Err(AudioError::InvalidConfig("truncated fmt chunk".into()));
                }
                let format = u16::from_le_bytes([body[0], body[1]]);
                let channels = u16::from_le_bytes([body[2], body[3]]);
                let rate = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
                let bits = u16::from_le_bytes([body[14], body[15]]);
                spec = Some((format, channels, rate, bits));
            }
            b"data" => pcm = Some(body),
            _ => {}
        }
        // Chunks are word-aligned.
        cursor = body_end + (size & 1);
    }

    let (format, channels, sample_rate, bits) =
        spec.ok_or_else(|| AudioError::InvalidConfig("wav has no fmt chunk".to_string()))?;
    let pcm = pcm.ok_or_else(|| AudioError::InvalidConfig("wav has no data chunk".to_string()))?;
    if !(1..=8).contains(&channels) {
        return Err(AudioError::InvalidConfig(format!(
            "wav channel count {channels} is outside 1-8"
        )));
    }
    if sample_rate == 0 {
        return Err(AudioError::InvalidConfig("wav sample rate is zero".into()));
    }

    let interleaved: Vec<f32> = match (format, bits) {
        (1, 16) => pcm
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| i16::from_le_bytes(*pair) as f32 / f32::from(i16::MAX))
            .collect(),
        (3, 32) => pcm
            .as_chunks::<4>()
            .0
            .iter()
            .map(|quad| f32::from_le_bytes(*quad))
            .map(|sample| {
                if sample.is_finite() {
                    sample.clamp(-1.0, 1.0)
                } else {
                    0.0
                }
            })
            .collect(),
        (1, bits) => {
            return Err(AudioError::InvalidConfig(format!(
                "unsupported PCM bit depth: {bits}"
            )))
        }
        (3, bits) => {
            return Err(AudioError::InvalidConfig(format!(
                "unsupported float bit depth: {bits}"
            )))
        }
        (format, _) => {
            return Err(AudioError::InvalidConfig(format!(
                "unsupported wav format tag: {format}"
            )))
        }
    };

    let channels_usize = channels as usize;
    let samples = if channels_usize == 1 {
        interleaved
    } else {
        interleaved
            .chunks_exact(channels_usize)
            .map(|frame| frame.iter().sum::<f32>() / channels_usize as f32)
            .collect()
    };

    Ok(WavAudio {
        samples,
        sample_rate,
        channels,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn spec() -> WavSpec {
        WavSpec::new(16_000, 1).unwrap()
    }

    #[test]
    fn header_is_canonical_and_sizes_are_patched() {
        let mut writer = WavWriter::new(Cursor::new(Vec::new()), spec()).unwrap();
        writer.write_samples(&[0.0, 0.5, -0.5, 1.0]).unwrap();
        assert_eq!(writer.data_bytes(), 8);
        assert_eq!(writer.frames(), 4);
        assert_eq!(writer.duration_ms(), 0);
        let cursor = writer.into_inner().unwrap();
        let bytes = cursor.into_inner();

        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 36 + 8);
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(&bytes[12..16], b"fmt ");
        assert_eq!(u32::from_le_bytes(bytes[16..20].try_into().unwrap()), 16);
        assert_eq!(u16::from_le_bytes(bytes[20..22].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(bytes[22..24].try_into().unwrap()), 1);
        assert_eq!(
            u32::from_le_bytes(bytes[24..28].try_into().unwrap()),
            16_000
        );
        assert_eq!(
            u32::from_le_bytes(bytes[28..32].try_into().unwrap()),
            32_000
        );
        assert_eq!(u16::from_le_bytes(bytes[32..34].try_into().unwrap()), 2);
        assert_eq!(u16::from_le_bytes(bytes[34..36].try_into().unwrap()), 16);
        assert_eq!(&bytes[36..40], b"data");
        assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 8);
        assert_eq!(bytes.len(), 44 + 8);
    }

    #[test]
    fn samples_round_trip_through_pcm16() {
        let mut writer = WavWriter::new(Cursor::new(Vec::new()), spec()).unwrap();
        writer.write_samples(&[0.0, 0.5, -0.5]).unwrap();
        let bytes = writer.into_inner().unwrap().into_inner();
        let pcm: Vec<i16> = bytes[44..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| i16::from_le_bytes(*pair))
            .collect();
        assert_eq!(pcm[0], 0);
        assert_eq!(pcm[1], 16_384);
        assert_eq!(pcm[2], -16_384);
    }

    #[test]
    fn out_of_range_and_non_finite_samples_are_clipped() {
        assert_eq!(encode_pcm16(2.5), i16::MAX.to_le_bytes());
        assert_eq!(encode_pcm16(-2.5), (-i16::MAX).to_le_bytes());
        assert_eq!(encode_pcm16(f32::NAN), 0i16.to_le_bytes());
        assert_eq!(encode_pcm16(f32::INFINITY), 0i16.to_le_bytes());
    }

    #[test]
    fn duration_tracks_the_sample_clock_not_the_wall_clock() {
        let mut writer = WavWriter::new(Cursor::new(Vec::new()), spec()).unwrap();
        writer.write_samples(&vec![0.0; 16_000]).unwrap();
        assert_eq!(writer.duration_ms(), 1_000);
        writer.write_samples(&vec![0.0; 8_000]).unwrap();
        assert_eq!(writer.duration_ms(), 1_500);
    }

    #[test]
    fn stereo_block_align_and_byte_rate_are_consistent() {
        let spec = WavSpec::new(48_000, 2).unwrap();
        assert_eq!(spec.block_align(), 4);
        assert_eq!(spec.byte_rate(), 192_000);
        let mut writer = WavWriter::new(Cursor::new(Vec::new()), spec).unwrap();
        writer.write_samples(&[0.0; 96_000]).unwrap();
        assert_eq!(writer.frames(), 48_000);
        assert_eq!(writer.duration_ms(), 1_000);
    }

    #[test]
    fn invalid_specs_are_rejected() {
        assert!(WavSpec::new(0, 1).is_err());
        assert!(WavSpec::new(16_000, 0).is_err());
        assert!(WavSpec::new(16_000, 9).is_err());
        assert!(WavSpec::new(384_000, 1).is_err());
    }

    #[test]
    fn reader_round_trips_writer_output() {
        let mut writer = WavWriter::new(Cursor::new(Vec::new()), spec()).unwrap();
        writer.write_samples(&[0.0, 0.5, -0.5]).unwrap();
        let bytes = writer.into_inner().unwrap().into_inner();
        let audio = read_wav_bytes(&bytes).unwrap();
        assert_eq!(audio.sample_rate, 16_000);
        assert_eq!(audio.channels, 1);
        assert_eq!(audio.samples.len(), 3);
        assert_eq!(audio.samples[0], 0.0);
        assert!((audio.samples[1] - 0.5).abs() < 1e-4);
        assert!((audio.samples[2] + 0.5).abs() < 1e-4);
    }

    #[test]
    fn reader_skips_unknown_chunks_and_downmixes_stereo() {
        let spec = WavSpec::new(16_000, 2).unwrap();
        let mut writer = WavWriter::new(Cursor::new(Vec::new()), spec).unwrap();
        writer.write_samples(&[1.0, -1.0, 0.5, 0.5]).unwrap();
        let mut bytes = writer.into_inner().unwrap().into_inner();
        // Splice a LIST chunk between fmt and data.
        let data_offset = 36;
        let list = b"LIST\x04\x00\x00\x00info";
        bytes.splice(data_offset..data_offset, list.iter().copied());
        // Patch RIFF size so the file stays internally consistent.
        let riff = (bytes.len() - 8) as u32;
        bytes[4..8].copy_from_slice(&riff.to_le_bytes());

        let audio = read_wav_bytes(&bytes).unwrap();
        assert_eq!(audio.channels, 2);
        assert_eq!(audio.samples.len(), 2);
        assert!(audio.samples[0].abs() < 1e-4);
        assert!((audio.samples[1] - 0.5).abs() < 1e-4);
    }

    #[test]
    fn reader_rejects_non_wav_and_unsupported_depths() {
        assert!(read_wav_bytes(b"not a wave file").is_err());

        let mut writer = WavWriter::new(Cursor::new(Vec::new()), spec()).unwrap();
        writer.write_samples(&[0.0; 8]).unwrap();
        let mut bytes = writer.into_inner().unwrap().into_inner();
        // Claim 24-bit samples: the reader must refuse rather than misread.
        bytes[34..36].copy_from_slice(&24u16.to_le_bytes());
        assert!(read_wav_bytes(&bytes).is_err());
    }

    #[test]
    fn reader_rejects_truncated_chunks() {
        let mut writer = WavWriter::new(Cursor::new(Vec::new()), spec()).unwrap();
        writer.write_samples(&[0.0; 64]).unwrap();
        let mut bytes = writer.into_inner().unwrap().into_inner();
        bytes.truncate(60);
        assert!(read_wav_bytes(&bytes).is_err());
    }

    #[test]
    fn drop_finalizes_an_unclosed_file() {
        let dir = std::env::temp_dir().join(format!("memo-wav-{}", std::process::id()));
        let path = dir.join("take.wav");
        {
            let mut writer = WavWriter::create(&path, spec()).unwrap();
            writer.write_samples(&vec![0.1; 1_000]).unwrap();
            // No explicit finalize: Drop must patch the header.
        }
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(
            u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            36 + 2_000
        );
        assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 2_000);
        let _ = std::fs::remove_dir_all(dir);
    }
}
