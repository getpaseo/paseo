#include "GpuiModules.h"

namespace gpui_worklets {
void onFrame(double timestampMs);
}

namespace rngpui {
void rn_gpui_install_worklets_module() {
  registerFrameCallback(
      [](double timestampMs) { gpui_worklets::onFrame(timestampMs); });
}

} // namespace rngpui
