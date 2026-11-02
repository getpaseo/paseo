#pragma once

#include <react/renderer/scheduler/SurfaceDelegate.h>

#include <string>

namespace rngpui {
class GpuiHost;

/// React renders LogBox into a second React surface (app key `"LogBox"`). It
/// is shown as an overlay in the main window; `hide()` stops the surface so
/// nothing covers the app while LogBox is closed.
class GpuiLogBoxSurfaceDelegate : public facebook::react::SurfaceDelegate {
 public:
  explicit GpuiLogBoxSurfaceDelegate(GpuiHost& host) : host_(host) {}

  void createContentView(std::string appKey) override;
  bool isContentViewReady() override;
  void destroyContentView() override;
  void show() override;
  void hide() override;
  bool isShowing() override;

 private:
  GpuiHost& host_;
  std::string appKey_;
  bool ready_{false};
  bool showing_{false};
};

} // namespace rngpui
