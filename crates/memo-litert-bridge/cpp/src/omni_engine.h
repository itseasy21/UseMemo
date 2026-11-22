#pragma once

#include <cstdint>
#include <string>

namespace memo {

struct GenerateOptions {
  float temperature = 0.0f;
  float top_p = 1.0f;
  std::uint32_t top_k = 1;
  std::uint32_t max_output_tokens = 2048;
};

// Owns the LiteRT-LM engine and one reusable session. The scaffold keeps the
// surface small so the upstream runtime can be linked in one place.
class OmniEngine {
 public:
  OmniEngine() = default;
  ~OmniEngine();

  OmniEngine(const OmniEngine&) = delete;
  OmniEngine& operator=(const OmniEngine&) = delete;

  bool Load(const std::string& model_path, const std::string& backend,
            std::uint32_t max_seq_len, std::string* error);
  void Unload();
  bool loaded() const { return loaded_; }

  std::string Generate(const std::string& system, const std::string& user,
                       const GenerateOptions& options, std::string* error);

 private:
  bool loaded_ = false;
  std::string model_path_;
  std::string backend_;
  std::uint32_t max_seq_len_ = 0;
  void* engine_ = nullptr;
  void* session_ = nullptr;
};

}  // namespace memo
