cmake_minimum_required(VERSION 3.24)
project(memo_litert_worker LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(memo-litert-worker
  src/main.cpp
  src/omni_engine.cpp
)
target_include_directories(memo-litert-worker PRIVATE src)
target_compile_options(memo-litert-worker PRIVATE -Wall -Wextra -Wpedantic)

# The IPC scaffold builds without LiteRT-LM. To link the real runtime:
#   1. Clone google-ai-edge/LiteRT-LM into third_party/litert-lm.
#   2. Follow its Bazel/CMake build for the OmniEngine/OmniSession targets.
#   3. Add the include dir and link library below, then define MEMO_LITERT_LINKED.
#
# target_include_directories(memo-litert-worker PRIVATE third_party/litert-lm/include)
# target_link_libraries(memo-litert-worker PRIVATE litert_lm)
# target_compile_definitions(memo-litert-worker PRIVATE MEMO_LITERT_LINKED=1)

install(TARGETS memo-litert-worker RUNTIME DESTINATION bin)
