#include <cctype>
#include <cstdint>
#include <iostream>
#include <optional>
#include <sstream>
#include <string>

#include "frame_io.h"
#include "omni_engine.h"

namespace {

std::optional<std::size_t> FindKey(const std::string& json, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  const auto position = json.find(needle);
  if (position == std::string::npos) {
    return std::nullopt;
  }
  const auto colon = json.find(':', position + needle.size());
  if (colon == std::string::npos) {
    return std::nullopt;
  }
  return colon + 1;
}

std::string ExtractString(const std::string& json, const std::string& key) {
  const auto start = FindKey(json, key);
  if (!start.has_value()) {
    return {};
  }
  std::size_t index = *start;
  while (index < json.size() && std::isspace(static_cast<unsigned char>(json[index]))) {
    ++index;
  }
  if (index >= json.size() || json[index] != '"') {
    return {};
  }
  ++index;
  std::string out;
  while (index < json.size()) {
    const char character = json[index++];
    if (character == '"') {
      break;
    }
    if (character == '\\' && index < json.size()) {
      const char escaped = json[index++];
      switch (escaped) {
        case 'n':
          out.push_back('\n');
          break;
        case 'r':
          out.push_back('\r');
          break;
        case 't':
          out.push_back('\t');
          break;
        case '"':
          out.push_back('"');
          break;
        case '\\':
          out.push_back('\\');
          break;
        case 'u': {
          if (index + 4 <= json.size()) {
            const unsigned int code = static_cast<unsigned int>(
                std::stoul(json.substr(index, 4), nullptr, 16));
            out.push_back(code < 128 ? static_cast<char>(code) : '?');
            index += 4;
          }
          break;
        }
        default:
          out.push_back(escaped);
          break;
      }
    } else {
      out.push_back(character);
    }
  }
  return out;
}

double ExtractNumber(const std::string& json, const std::string& key,
                     double fallback) {
  const auto start = FindKey(json, key);
  if (!start.has_value()) {
    return fallback;
  }
  try {
    std::size_t consumed = 0;
    const double value = std::stod(json.substr(*start), &consumed);
    return consumed == 0 ? fallback : value;
  } catch (...) {
    return fallback;
  }
}

std::string JsonEscape(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 16);
  for (const char character : value) {
    switch (character) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (static_cast<unsigned char>(character) < 0x20) {
          out += " ";
        } else {
          out.push_back(character);
        }
        break;
    }
  }
  return out;
}

std::string IdField(const std::string& json) {
  const auto id = FindKey(json, "id");
  if (!id.has_value()) {
    return "";
  }
  try {
    return std::to_string(static_cast<long long>(std::stod(json.substr(*id))));
  } catch (...) {
    return "";
  }
}

std::string Ready() {
  return R"({"type":"ready","protocolVersion":1,"backend":"cpu"})";
}

std::string Pong() { return R"({"type":"pong"})"; }

std::string Error(const std::string& id, const std::string& message) {
  std::ostringstream out;
  out << "{\"type\":\"error\"";
  if (!id.empty()) {
    out << ",\"id\":" << id;
  }
  out << ",\"message\":\"" << JsonEscape(message) << "\"}";
  return out.str();
}

std::string Result(const std::string& id, const std::string& text) {
  std::ostringstream out;
  out << "{\"type\":\"result\",\"id\":" << (id.empty() ? "0" : id)
      << ",\"text\":\"" << JsonEscape(text) << "\"}";
  return out.str();
}

}  // namespace

int main() {
  std::ios::sync_with_stdio(false);
  memo::OmniEngine engine;
  std::string payload;
  std::string error;

  while (memo::ipc::ReadFrame(std::cin, &payload, &error)) {
    const std::string type = ExtractString(payload, "type");
    const std::string id = IdField(payload);
    std::string response;

    if (type == "hello") {
      response = Ready();
    } else if (type == "ping") {
      response = Pong();
    } else if (type == "load") {
      const std::string model_path = ExtractString(payload, "modelPath");
      const std::string backend = ExtractString(payload, "backend");
      const auto max_seq_len =
          static_cast<std::uint32_t>(ExtractNumber(payload, "maxSeqLen", 4096));
      std::string load_error;
      if (engine.Load(model_path, backend, max_seq_len, &load_error)) {
        response = Ready();
      } else {
        response = Error(id, load_error);
      }
    } else if (type == "generate") {
      memo::GenerateOptions options;
      options.temperature =
          static_cast<float>(ExtractNumber(payload, "temperature", 0.0));
      options.top_p = static_cast<float>(ExtractNumber(payload, "topP", 1.0));
      options.top_k = static_cast<std::uint32_t>(ExtractNumber(payload, "topK", 1));
      options.max_output_tokens = static_cast<std::uint32_t>(
          ExtractNumber(payload, "maxOutputTokens", 2048));
      std::string generate_error;
      const std::string text =
          engine.Generate(ExtractString(payload, "system"),
                          ExtractString(payload, "user"), options,
                          &generate_error);
      response = generate_error.empty() ? Result(id, text)
                                        : Error(id, generate_error);
    } else if (type == "shutdown") {
      memo::ipc::WriteFrame(std::cout, Result(id, "bye"));
      return 0;
    } else {
      response = Error(id, "unknown request type: " + type);
    }

    memo::ipc::WriteFrame(std::cout, response);
  }

  if (!error.empty()) {
    std::cerr << "worker protocol error: " << error << "\n";
    return 2;
  }
  return 0;
}
