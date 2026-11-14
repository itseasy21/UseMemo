#pragma once

#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

namespace memo::ipc {

constexpr std::uint32_t kMaxFrameBytes = 16u * 1024u * 1024u;

inline bool ReadExact(std::istream& input, char* destination, std::size_t count) {
  input.read(destination, static_cast<std::streamsize>(count));
  return input.gcount() == static_cast<std::streamsize>(count);
}

// Reads one big-endian length-prefixed frame. Returns false on clean EOF.
inline bool ReadFrame(std::istream& input, std::string* payload, std::string* error) {
  unsigned char header[4] = {0, 0, 0, 0};
  input.read(reinterpret_cast<char*>(header), 4);
  if (input.gcount() == 0) {
    return false;
  }
  if (input.gcount() != 4) {
    *error = "truncated frame header";
    return false;
  }
  const std::uint32_t length = (static_cast<std::uint32_t>(header[0]) << 24) |
                               (static_cast<std::uint32_t>(header[1]) << 16) |
                               (static_cast<std::uint32_t>(header[2]) << 8) |
                               static_cast<std::uint32_t>(header[3]);
  if (length > kMaxFrameBytes) {
    *error = "frame exceeds 16 MiB limit";
    return false;
  }
  payload->resize(length);
  if (length > 0 && !ReadExact(input, payload->data(), length)) {
    *error = "truncated frame payload";
    return false;
  }
  return true;
}

inline void WriteFrame(std::ostream& output, const std::string& payload) {
  const std::uint32_t length = static_cast<std::uint32_t>(payload.size());
  const char header[4] = {
      static_cast<char>((length >> 24) & 0xFF),
      static_cast<char>((length >> 16) & 0xFF),
      static_cast<char>((length >> 8) & 0xFF),
      static_cast<char>(length & 0xFF),
  };
  output.write(header, 4);
  output.write(payload.data(), static_cast<std::streamsize>(payload.size()));
  output.flush();
}

}  // namespace memo::ipc
