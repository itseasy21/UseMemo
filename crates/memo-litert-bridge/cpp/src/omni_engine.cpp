#include "omni_engine.h"

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>

namespace memo {
namespace {

#if defined(MEMO_LITERT_LINKED)
// When the upstream runtime is vendored, include its C++ headers here and
// replace the two hook functions below. Keeping the include behind a macro lets
// the IPC scaffold build on machines without the multi-GB Bazel tree.
// #include "litert_lm/omni_engine.h"

bool LitertLoad(const std::string&, const std::string&, std::uint32_t, void**,
                void**, std::string* error) {
  *error = "LiteRT-LM hooks are not wired yet";
  return false;
}

std::string LitertGenerate(void*, void*, const std::string&, const std::string&,
                           const GenerateOptions&, std::string* error) {
  *error = "LiteRT-LM hooks are not wired yet";
  return {};
}

void LitertUnload(void*, void*) {}
#else
bool StubLoad(std::string* error) {
  *error =
      "LiteRT-LM runtime is not linked. Build with "
      "-DMEMO_LITERT_LINKED=ON and the upstream google-ai-edge/LiteRT-LM tree.";
  return false;
}
#endif

}  // namespace

OmniEngine::~OmniEngine() { Unload(); }

bool OmniEngine::Load(const std::string& model_path, const std::string& backend,
                      std::uint32_t max_seq_len, std::string* error) {
  if (!std::filesystem::is_regular_file(model_path)) {
    *error = "model file not found: " + model_path;
    return false;
  }
  Unload();
  model_path_ = model_path;
  backend_ = backend.empty() ? "cpu" : backend;
  max_seq_len_ = max_seq_len == 0 ? 4096 : max_seq_len;

#if defined(MEMO_LITERT_LINKED)
  if (!LitertLoad(model_path_, backend_, max_seq_len_, &engine_, &session_,
                  error)) {
    return false;
  }
#else
  // The scaffold validates the request but refuses to pretend a model is
  // loaded when the runtime is absent.
  return StubLoad(error);
#endif
  loaded_ = true;
  return true;
}

void OmniEngine::Unload() {
#if defined(MEMO_LITERT_LINKED)
  if (engine_ != nullptr || session_ != nullptr) {
    LitertUnload(engine_, session_);
  }
#endif
  engine_ = nullptr;
  session_ = nullptr;
  loaded_ = false;
}

std::string OmniEngine::Generate(const std::string& system,
                                 const std::string& user,
                                 const GenerateOptions& options,
                                 std::string* error) {
  if (!loaded_) {
    *error = "no model is loaded";
    return {};
  }
#if defined(MEMO_LITERT_LINKED)
  return LitertGenerate(engine_, session_, system, user, options, error);
#else
  (void)system;
  (void)user;
  (void)options;
  *error = "LiteRT-LM runtime is not linked";
  return {};
#endif
}

}  // namespace memo
