#include "GpuiLogBoxSurfaceDelegate.h"

#include "GpuiHost.h"
#include "rn-gpui-sys/src/lib.rs.h" // cxx bridge

#include <utility>

namespace rngpui {
void GpuiLogBoxSurfaceDelegate::createContentView(std::string appKey) {
  appKey_ = std::move(appKey);
  ready_ = true;
  rn_gpui_log(1, "LogBox content view created (appKey=" + appKey_ + ")");
}

bool GpuiLogBoxSurfaceDelegate::isContentViewReady() {
  return ready_;
}

void GpuiLogBoxSurfaceDelegate::destroyContentView() {
  if (showing_) {
    hide();
  }
  ready_ = false;
  rn_gpui_log(1, "LogBox content view destroyed");
}

void GpuiLogBoxSurfaceDelegate::show() {
  if (!ready_ || showing_) {
    return;
  }
  showing_ = true;
  rn_gpui_log(1, "LogBox shown");
  host_.start_log_box_surface();
}

void GpuiLogBoxSurfaceDelegate::hide() {
  if (!showing_) {
    return;
  }
  showing_ = false;
  rn_gpui_log(1, "LogBox hidden");
  host_.stop_log_box_surface();
}

bool GpuiLogBoxSurfaceDelegate::isShowing() {
  return showing_;
}

} // namespace rngpui
