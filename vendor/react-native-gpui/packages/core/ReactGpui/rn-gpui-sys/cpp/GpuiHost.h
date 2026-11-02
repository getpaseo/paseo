// cxx compares the exact signature of each member function, so `&str`
// parameters must be `rust::Str`; a `const std::string&` fails with
// "type mismatch at 1st parameter".
#pragma once

#include "rust/cxx.h"

#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace facebook::react {
class ReactHost;
class RunLoopObserverManager;
class NativeAnimatedNodesManagerProvider;
class UIManager;
struct RawEvent;
using EventListener = std::function<bool(const RawEvent&)>;
} // namespace facebook::react

namespace folly {
// folly defines `dynamic` as a struct. MSVC puts the class/struct key into the
// mangled name (`V` vs `U`), so forward-declaring it as a class here mangles
// `gpui_synchronously_update_props` differently from the definition in
// GpuiHost.cpp, and the app-side archive fails to link with LNK2019.
struct dynamic;
} // namespace folly

namespace rngpui {
class GpuiMountingManager;
class GpuiLogBoxSurfaceDelegate;

constexpr int32_t kAppSurfaceId = 1;
constexpr int32_t kLogBoxSurfaceId = 2;
constexpr int32_t kAllSurfacesStopped = -1;

class GpuiHost {
 public:
  GpuiHost(
      rust::Str appId,
      rust::Str devHost,
      uint32_t devPort,
      rust::Str jsEngine,
      bool devMode);
  ~GpuiHost();

  bool load_script(rust::Str bundlePath, rust::Str sourceUrl);
  void start_surface(
      int32_t surfaceId,
      rust::Str moduleName,
      float w,
      float h,
      float scale);
  void start_surface_with_props(
      int32_t surfaceId,
      rust::Str moduleName,
      rust::Str propsJson,
      float w,
      float h,
      float scale);
  void set_surface_size(int32_t surfaceId, float w, float h, float scale);
  /// Starts a surface whose size is a range rather than a point: `FitContent`.
  /// Fabric lays the root out against these constraints and the
  /// resulting size comes back in every mount batch as `content_width` /
  /// `content_height`.
  void start_surface_with_constraints(
      int32_t surfaceId,
      rust::Str moduleName,
      rust::Str propsJson,
      float minWidth,
      float minHeight,
      float maxWidth,
      float maxHeight,
      float scale);
  /// Changes an existing surface's constraints, which is what a resize of an
  /// embedded surface does.
  void set_surface_constraints(
      int32_t surfaceId,
      float minWidth,
      float minHeight,
      float maxWidth,
      float maxHeight,
      float scale);
  void set_window_metrics(float w, float h, float scale);
  void set_window_top_inset(float top);
  void set_system_appearance(rust::Str appearance);
  void stop_surface(int32_t surfaceId);
  void open_debugger() const;
  uint64_t js_frame_probe() const;
  uint64_t js_heap_bytes() const;
  void on_render() const;
  void on_frame(double eventTimestampMs) const;
  void on_pointer_frame(double eventTimestampMs) const;
  void dispatch_event(int32_t tag, rust::Str type, rust::Str payloadJson) const;
  void emit_device_event(rust::Str event_name) const;
  void emit_device_event_bool(rust::Str event_name, bool value) const;
  void emit_device_event_json(rust::Str event_name, rust::Str payload_json)
      const;
  void emit_accessibility_setting_event(
      const std::string& event_name,
      bool enabled) const;
  void dispatch_pointer_event(
      rust::Str targetChainJson,
      float x,
      float y,
      int32_t phase,
      double timestamp) const;
  void set_scroll_offset(int32_t tag, float x, float y) const;
  std::shared_ptr<facebook::react::UIManager> ui_manager() const;
  void synchronously_update_props(int32_t tag, const folly::dynamic& props)
      const;
  void add_event_listener(
      std::shared_ptr<const facebook::react::EventListener> listener);

  void request_reload();
  bool set_dev_server(rust::Str host, uint32_t port);
  rust::String dev_server_address() const;
  bool reload_in_progress() const;
  /// Counts the React instances created so far; see
  /// `ReactHost::instanceGeneration`.
  uint64_t instance_generation() const;
  void start_log_box_surface();
  void stop_log_box_surface();

 private:
  std::shared_ptr<GpuiMountingManager> mountingManager_;
  std::shared_ptr<facebook::react::RunLoopObserverManager>
      runLoopObserverManager_;
  /// Passed to ReactHost as its `logBoxSurfaceDelegate`. Created
  /// before the host because ReactHost takes it in its constructor.
  std::shared_ptr<GpuiLogBoxSurfaceDelegate> logBoxDelegate_;
  /// Passed to ReactHost as its `animatedNodesManagerProvider`. It
  /// is what makes `AnimatedModule` load; without it LogBox's inspector throws
  /// "Native animated module is not available" and no red box renders.
  std::shared_ptr<facebook::react::NativeAnimatedNodesManagerProvider>
      animatedNodesManagerProvider_;
  mutable std::recursive_mutex animatedFrameMutex_;
  mutable std::function<void()> animatedFrameCallback_;
  std::unique_ptr<facebook::react::ReactHost> reactHost_;
  std::vector<std::shared_ptr<const facebook::react::EventListener>>
      eventListeners_;
  float surfaceWidth_{0.};
  float surfaceHeight_{0.};
  float surfaceScale_{1.};
  bool scriptLoaded_{false};
};

std::unique_ptr<GpuiHost> new_gpui_host(
    rust::Str appId,
    rust::Str devHost,
    uint32_t devPort,
    rust::Str jsEngine,
    bool devMode);
std::shared_ptr<facebook::react::UIManager> get_gpui_ui_manager();
void gpui_synchronously_update_props(int32_t tag, const folly::dynamic& props);
void register_gpui_event_listener(
    std::shared_ptr<const facebook::react::EventListener> listener);
/// Runs the task a module posted with `rngpui::dispatchMain`. Called on the
/// GPUI main thread.
void rn_gpui_run_main_task(uint64_t id);
} // namespace rngpui
