# LiteRT-LM sidecar worker

The C++20 worker owns the on-device LiteRT-LM `OmniEngine`/`OmniSession` and
speaks a length-prefixed stdio protocol with the Rust app. It never opens a
socket and never loads a remote model.

## Protocol

Every frame is a **4-byte big-endian payload length** followed by UTF-8 JSON.
Maximum payload is 16 MiB.

| Request | Fields | Response |
| --- | --- | --- |
| `hello` | `protocolVersion` | `ready` |
| `ping` | — | `pong` |
| `load` | `modelPath`, `backend?`, `maxSeqLen?` | `ready` or `error` |
| `generate` | `system`, `user`, `temperature`, `topP`, `topK`, `maxOutputTokens` | `token*` then `result`; or `error` |
| `shutdown` | — | `result` then process exit |

Requests carry a monotonic `id`; responses echo it. `token` frames are
streaming deltas. Example:

```json
{"id":7,"type":"generate","system":"...","user":"...","temperature":0.0,"topP":1.0,"topK":1,"maxOutputTokens":2048}
{"type":"token","id":7,"text":"{\"summary\""}
{"type":"result","id":7,"text":"{\"summary\":[],\"decisions\":[],\"actionItems\":[]}"}
```

The app parses and verifies the final JSON deterministically
(`synthesis::verifier`); the worker is not trusted to ground evidence.

## Build the scaffold

```bash
cmake -S crates/memo-litert-bridge/cpp -B /tmp/memo-litert-worker-build
cmake --build /tmp/memo-litert-worker-build
```

The scaffold compiles without LiteRT-LM and refuses `load` with a clear error.
It is useful for protocol tests and for validating the app-side client.

## Build the real worker (M5.4, blocked on host)

1. Clone `google-ai-edge/LiteRT-LM` and follow its Bazel instructions for the
   OmniEngine/OmniSession targets.
2. Wire the hooks in `src/omni_engine.cpp` (`MEMO_LITERT_LINKED`).
3. Build with Bazel/CMake and place the binary next to the app resources.
4. Point the app at it with `MEMO_LITERT_WORKER=/path/to/memo-litert-worker`;
   otherwise the app installs a fail-closed `UnavailableEngine` and synthesis
   returns a clear "install a model" error instead of calling any network API.

The model path is resolved from the brand's LiteRT registry and must be a local
file. Model weights are never vendored in git.
