//! Isolated local GGUF inference worker speaking the length-prefixed
//! `memo-litert-bridge` stdio protocol.
//!
//! Isolating `llama.cpp` in its own Rust workspace binary guarantees:
//! 1. Zero `ggml_*` / `ggml-metal` C/ObjC symbol collisions with `whisper-rs`
//!    inside the main Tauri process.
//! 2. Deterministic OS memory reclamation when the worker shuts down on 8 GB hosts.
//! 3. Fault isolation: a corrupt GGUF or GPU driver reset never aborts an active
//!    audio recording in the parent process.

use std::io::{self, BufReader, BufWriter, Write};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{LlamaChatMessage, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use memo_litert_bridge::{
    read_frame, write_frame, RequestEnvelope, WorkerRequest, WorkerResponse, PROTOCOL_VERSION,
};

/// Strict GBNF grammar constraining generation to a single valid JSON object.
pub const DEFAULT_JSON_OBJECT_GBNF: &str = r#"
root   ::= ws object ws
value  ::= object | array | string | number | ("true" | "false" | "null") ws
object ::=
  "{" ws (
            string ":" ws value
    ("," ws string ":" ws value)*
  )? "}" ws
array  ::=
  "[" ws (
            value
    ("," ws value)*
  )? "]" ws
string ::=
  "\"" (
    [^"\\\x7F\x00-\x1F] |
    "\\" (["\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F])
  )* "\"" ws
number ::= ("-"? ([0-9] | [1-9] [0-9]*)) ("." [0-9]+)? ([eE] [-+]? [0-9]+)? ws
ws     ::= ([ \t\n\r])*
"#;

const EVAL_BATCH_SIZE: usize = 1024;
const DEFAULT_MAX_SEQ_LEN: u32 = 16_384;

struct LoadedModel {
    path: PathBuf,
    backend_label: String,
    max_seq_len: u32,
    model: LlamaModel,
}

/// Accumulates raw UTF-8 bytes from sub-character BPE tokens and yields valid
/// UTF-8 slices as soon as codepoints complete.
#[derive(Default)]
struct Utf8StreamBuffer {
    pending: Vec<u8>,
}

impl Utf8StreamBuffer {
    fn push_bytes(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        match std::str::from_utf8(&self.pending) {
            Ok(valid) => {
                let out = valid.to_string();
                self.pending.clear();
                out
            }
            Err(error) => {
                let valid_len = error.valid_up_to();
                if valid_len == 0 {
                    if error.error_len().is_some() {
                        // Invalid byte sequence: lossy decode and clear so we never stall.
                        let out = String::from_utf8_lossy(&self.pending).into_owned();
                        self.pending.clear();
                        return out;
                    }
                    return String::new();
                }
                let valid_prefix = String::from_utf8_lossy(&self.pending[..valid_len]).into_owned();
                self.pending.drain(..valid_len);
                valid_prefix
            }
        }
    }

    fn finish(self) -> String {
        if self.pending.is_empty() {
            String::new()
        } else {
            String::from_utf8_lossy(&self.pending).into_owned()
        }
    }
}

fn format_prompt(model: &LlamaModel, system: &str, user: &str) -> String {
    if let Ok(tmpl) = model.chat_template(None) {
        if let (Ok(sys_msg), Ok(usr_msg)) = (
            LlamaChatMessage::new("system".to_string(), system.to_string()),
            LlamaChatMessage::new("user".to_string(), user.to_string()),
        ) {
            if let Ok(rendered) = model.apply_chat_template(&tmpl, &[sys_msg, usr_msg], true) {
                return rendered;
            }
        }
        // Fallback for templates (e.g. Gemma) that merge system instructions into user role.
        let combined = format!("{}\n\n{}", system.trim(), user.trim());
        if let Ok(usr_msg) = LlamaChatMessage::new("user".to_string(), combined) {
            if let Ok(rendered) = model.apply_chat_template(&tmpl, &[usr_msg], true) {
                return rendered;
            }
        }
    }

    // ChatML universal fallback when a GGUF carries no embedded chat template.
    format!(
        "<|im_start|>system\n{}\n<|im_end|>\n<|im_start|>user\n{}\n<|im_end|>\n<|im_start|>assistant\n",
        system.trim(),
        user.trim()
    )
}

fn load_gguf_model(
    backend: &LlamaBackend,
    model_path: &Path,
    requested_backend: Option<&str>,
    max_seq_len: Option<u32>,
) -> Result<LoadedModel, String> {
    if !model_path.is_file() {
        return Err(format!(
            "GGUF model file not found: {}",
            model_path.display()
        ));
    }

    let want_gpu = requested_backend
        .map(|b| !b.eq_ignore_ascii_case("cpu"))
        .unwrap_or(cfg!(target_os = "macos"));

    let seq_len = max_seq_len
        .unwrap_or(DEFAULT_MAX_SEQ_LEN)
        .clamp(2048, 32_768);

    if want_gpu {
        let gpu_params = LlamaModelParams::default().with_n_gpu_layers(99);
        match LlamaModel::load_from_file(backend, model_path, &gpu_params) {
            Ok(model) => {
                return Ok(LoadedModel {
                    path: model_path.to_path_buf(),
                    backend_label: if cfg!(target_os = "macos") {
                        "metal".into()
                    } else {
                        "gpu".into()
                    },
                    max_seq_len: seq_len,
                    model,
                });
            }
            Err(gpu_err) => {
                eprintln!(
                    "[memo-llama-worker] GPU model load failed ({gpu_err}); falling back to CPU"
                );
            }
        }
    }

    let cpu_params = LlamaModelParams::default().with_n_gpu_layers(0);
    let model = LlamaModel::load_from_file(backend, model_path, &cpu_params)
        .map_err(|err| format!("failed to load GGUF model {}: {err}", model_path.display()))?;

    Ok(LoadedModel {
        path: model_path.to_path_buf(),
        backend_label: "cpu".into(),
        max_seq_len: seq_len,
        model,
    })
}

#[allow(clippy::too_many_arguments)]
fn run_generation<W: Write>(
    backend: &LlamaBackend,
    loaded: &LoadedModel,
    req_id: u64,
    system: &str,
    user: &str,
    temperature: f32,
    top_p: f32,
    top_k: u32,
    max_output_tokens: u32,
    grammar: Option<&str>,
    writer: &mut W,
) -> Result<String, String> {
    let prompt = format_prompt(&loaded.model, system, user);
    let prompt_tokens = loaded.model.vocab().tokenize(prompt.as_bytes(), true, true);
    if prompt_tokens.is_empty() {
        return Err("prompt tokenized to zero tokens".into());
    }

    let max_out = max_output_tokens.clamp(64, 8192);
    let required_ctx = (prompt_tokens.len() as u32)
        .saturating_add(max_out)
        .saturating_add(128);
    let max_allowed_ctx = loaded.max_seq_len.clamp(2048, 32_768);
    let effective_ctx = required_ctx
        .next_power_of_two()
        .clamp(2048, max_allowed_ctx);
    if prompt_tokens.len() as u32 + 64 >= effective_ctx {
        return Err(format!(
            "context window exceeded ({} prompt tokens >= {} max context)",
            prompt_tokens.len(),
            effective_ctx
        ));
    }

    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .saturating_sub(1)
        .clamp(1, 8) as i32;

    let ctx_params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(effective_ctx))
        .with_n_batch(EVAL_BATCH_SIZE as u32)
        .with_n_ubatch(512)
        .with_n_threads(threads)
        .with_n_threads_batch(threads);

    let mut ctx = loaded
        .model
        .new_context(backend, ctx_params)
        .map_err(|err| format!("cannot allocate llama context: {err}"))?;

    // Evaluate prompt in bounded chunks so large transcripts never overflow `n_batch`.
    let mut batch = LlamaBatch::new(EVAL_BATCH_SIZE, 1);
    let total_prompt = prompt_tokens.len();
    for chunk_start in (0..total_prompt).step_by(EVAL_BATCH_SIZE) {
        batch.clear();
        let chunk_end = (chunk_start + EVAL_BATCH_SIZE).min(total_prompt);
        for (idx, token) in prompt_tokens[chunk_start..chunk_end].iter().enumerate() {
            let global_pos = chunk_start + idx;
            let want_logits = global_pos + 1 == total_prompt;
            batch
                .add(*token, global_pos as i32, &[0], want_logits)
                .map_err(|err| format!("batch add failed: {err}"))?;
        }
        ctx.decode(&mut batch)
            .map_err(|err| format!("prompt decode failed: {err}"))?;
    }

    let mut samplers: Vec<LlamaSampler> = Vec::new();
    if let Some(gbnf) = grammar.map(str::trim).filter(|g| !g.is_empty()) {
        if let Ok(grammar_sampler) = LlamaSampler::grammar(&loaded.model, gbnf, "root") {
            samplers.push(grammar_sampler);
        }
    }
    if temperature <= 0.0 || top_k <= 1 {
        samplers.push(LlamaSampler::greedy());
    } else {
        samplers.push(LlamaSampler::top_k(top_k as i32));
        samplers.push(LlamaSampler::top_p(top_p.clamp(0.05, 1.0), 1));
        samplers.push(LlamaSampler::temp(temperature));
        samplers.push(LlamaSampler::dist(42));
    }
    let mut sampler = LlamaSampler::chain_simple(samplers);

    let mut full_text = String::new();
    let mut stream_utf8 = Utf8StreamBuffer::default();
    let mut last_batch_idx = (total_prompt - 1) % EVAL_BATCH_SIZE;

    for step in 0..max_out {
        let n_cur = (total_prompt + step as usize) as i32;
        // Note: `LlamaSampler::sample` calls `llama_sampler_sample`, which already
        // invokes `llama_sampler_accept(smpl, token)` internally. Calling
        // `sampler.accept(token)` a second time would double-advance GBNF grammars!
        let token = sampler.sample(&ctx, last_batch_idx as i32);

        if loaded.model.vocab().is_eog(token) {
            break;
        }

        let piece_bytes = loaded.model.vocab().token_to_piece(token, false, None);
        let delta = stream_utf8.push_bytes(&piece_bytes);
        if !delta.is_empty() {
            full_text.push_str(&delta);
            send_response(
                writer,
                &WorkerResponse::Token {
                    id: req_id,
                    text: delta,
                },
            )?;
        }

        batch.clear();
        batch
            .add(token, n_cur, &[0], true)
            .map_err(|err| format!("generation batch add failed: {err}"))?;
        ctx.decode(&mut batch)
            .map_err(|err| format!("generation decode failed: {err}"))?;
        last_batch_idx = 0;
    }

    let tail = stream_utf8.finish();
    if !tail.is_empty() {
        full_text.push_str(&tail);
        send_response(
            writer,
            &WorkerResponse::Token {
                id: req_id,
                text: tail,
            },
        )?;
    }

    Ok(full_text)
}

fn send_response<W: Write>(writer: &mut W, response: &WorkerResponse) -> Result<(), String> {
    let payload = serde_json::to_vec(response).map_err(|err| err.to_string())?;
    write_frame(writer, &payload).map_err(|err| err.to_string())
}

fn main() {
    let mut backend = match LlamaBackend::init() {
        Ok(b) => b,
        Err(err) => {
            eprintln!("[memo-llama-worker] failed to initialize llama.cpp backend: {err}");
            std::process::exit(1);
        }
    };
    backend.void_logs();

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());
    let mut loaded_model: Option<LoadedModel> = None;

    loop {
        let frame = match read_frame(&mut reader) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => break,
            Err(err) => {
                let _ = send_response(
                    &mut writer,
                    &WorkerResponse::Error {
                        id: None,
                        message: format!("frame read error: {err}"),
                    },
                );
                break;
            }
        };

        let envelope: RequestEnvelope = match serde_json::from_slice(&frame) {
            Ok(env) => env,
            Err(err) => {
                let _ = send_response(
                    &mut writer,
                    &WorkerResponse::Error {
                        id: None,
                        message: format!("invalid request JSON: {err}"),
                    },
                );
                continue;
            }
        };

        match envelope.request {
            WorkerRequest::Hello { protocol_version } => {
                if protocol_version != PROTOCOL_VERSION {
                    let _ = send_response(
                        &mut writer,
                        &WorkerResponse::Error {
                            id: Some(envelope.id),
                            message: format!(
                                "protocol mismatch: worker speaks v{PROTOCOL_VERSION}, client requested v{protocol_version}"
                            ),
                        },
                    );
                    continue;
                }
                let _ = send_response(
                    &mut writer,
                    &WorkerResponse::Ready {
                        protocol_version: PROTOCOL_VERSION,
                        backend: loaded_model.as_ref().map(|m| m.backend_label.clone()),
                        model: loaded_model
                            .as_ref()
                            .map(|m| m.path.to_string_lossy().into_owned()),
                    },
                );
            }
            WorkerRequest::Ping => {
                let _ = send_response(&mut writer, &WorkerResponse::Pong);
            }
            WorkerRequest::Shutdown => {
                let _ = send_response(
                    &mut writer,
                    &WorkerResponse::Ready {
                        protocol_version: PROTOCOL_VERSION,
                        backend: None,
                        model: None,
                    },
                );
                break;
            }
            WorkerRequest::Load {
                model_path,
                backend: req_backend,
                max_seq_len,
            } => {
                let path = PathBuf::from(&model_path);
                let already_loaded = loaded_model.as_ref().is_some_and(|m| m.path == path);
                if !already_loaded {
                    match load_gguf_model(&backend, &path, req_backend.as_deref(), max_seq_len) {
                        Ok(model) => loaded_model = Some(model),
                        Err(message) => {
                            let _ = send_response(
                                &mut writer,
                                &WorkerResponse::Error {
                                    id: Some(envelope.id),
                                    message,
                                },
                            );
                            continue;
                        }
                    }
                }
                let model_ref = loaded_model.as_ref();
                let _ = send_response(
                    &mut writer,
                    &WorkerResponse::Ready {
                        protocol_version: PROTOCOL_VERSION,
                        backend: model_ref.map(|m| m.backend_label.clone()),
                        model: model_ref.map(|m| m.path.to_string_lossy().into_owned()),
                    },
                );
            }
            WorkerRequest::Generate {
                system,
                user,
                temperature,
                top_p,
                top_k,
                max_output_tokens,
                grammar,
            } => {
                let Some(model) = loaded_model.as_ref() else {
                    let _ = send_response(
                        &mut writer,
                        &WorkerResponse::Error {
                            id: Some(envelope.id),
                            message: "no GGUF model is loaded in the synthesis worker".into(),
                        },
                    );
                    continue;
                };
                match run_generation(
                    &backend,
                    model,
                    envelope.id,
                    &system,
                    &user,
                    temperature,
                    top_p,
                    top_k,
                    max_output_tokens,
                    grammar.as_deref(),
                    &mut writer,
                ) {
                    Ok(text) => {
                        let _ = send_response(
                            &mut writer,
                            &WorkerResponse::Result {
                                id: envelope.id,
                                text,
                            },
                        );
                    }
                    Err(message) => {
                        let _ = send_response(
                            &mut writer,
                            &WorkerResponse::Error {
                                id: Some(envelope.id),
                                message,
                            },
                        );
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_stream_buffer_reassembles_split_multibyte_codepoints() {
        let mut buf = Utf8StreamBuffer::default();
        // '—' (em-dash) is [0xE2, 0x80, 0x94]
        assert_eq!(buf.push_bytes(&[0xE2]), "");
        assert_eq!(buf.push_bytes(&[0x80]), "");
        assert_eq!(buf.push_bytes(&[0x94, b' ', b'o', b'k']), "— ok");
        assert_eq!(buf.finish(), "");
    }

    #[test]
    fn default_json_grammar_contains_root_object_rule() {
        assert!(DEFAULT_JSON_OBJECT_GBNF.contains("root   ::= ws object ws"));
    }
}
