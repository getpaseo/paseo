#pragma once

#include <cstdlib>

namespace facebook::react {

inline bool gpuiDebugAnimationEnabled() noexcept {
  static const bool enabled = std::getenv("RN_GPUI_DEBUG_ANIMATION") != nullptr;
  return enabled;
}

} // namespace facebook::react
