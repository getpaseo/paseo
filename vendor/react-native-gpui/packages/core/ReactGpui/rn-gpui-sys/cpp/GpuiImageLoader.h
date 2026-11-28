#pragma once

#include <cstdint>
#include "rust/cxx.h"

namespace rngpui {
void rn_gpui_on_image_load_result(
    std::uint64_t request_id,
    double width,
    double height,
    rust::String error);
void rn_gpui_on_image_progress(
    std::uint64_t request_id,
    std::int64_t loaded,
    std::int64_t total);
} // namespace rngpui
