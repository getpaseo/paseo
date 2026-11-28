// Core has no built-in JS engine: an engine is an installed package that
// registers itself here.
#pragma once

#include <react/featureflags/ReactNativeFeatureFlagsOverridesOSSStable.h>

#include <jsi/jsi.h>

#include <atomic>
#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace facebook::react {
class CallInvoker;
class JSRuntimeFactory;
class TurboModule;
} // namespace facebook::react

namespace rngpui {
// Set by core when the renderer provides a frame source for the backend.
inline std::atomic<bool>& sharedAnimatedBackend() {
  static std::atomic<bool> enabled{false};
  return enabled;
}

class GpuiFeatureFlagsOverrides
    : public facebook::react::ReactNativeFeatureFlagsOverridesOSSStable {
 public:
  // React Native's C++ AnimatedModule queues operations until
  // finishOperationBatch(). GPUI is neither Android nor iOS, so RN's JS helper
  // only sends those batch boundaries when this flag is enabled.
  bool cxxNativeAnimatedEnabled() override {
    return true;
  }

  // Pressability's onHoverIn/onHoverOut ride on pointer enter and leave, which
  // GPUI delivers. The mouse-event path it otherwise takes is for web.
  bool shouldPressibilityUseW3CPointerEventsForHover() override {
    return true;
  }

  // Events without a priority of their own, such as onLayout, render at
  // default priority instead of synchronously. A live resize fires them every
  // frame, and as sync work they keep React committing until it trips its
  // nested update limit.
  bool fixMappingOfEventPrioritiesBetweenFabricAndReact() override {
    return true;
  }

  // `ref.focus()` and `ref.blur()` on a View send a command to the host
  // instead of doing nothing, as `HTMLElement.focus()` moves focus.
  bool enableImperativeFocus() override {
    return true;
  }

  // The shared animation backend needs a platform frame source: only the Loom
  // renderer provides one.
  bool useSharedAnimatedBackend() override {
    return sharedAnimatedBackend().load(std::memory_order_acquire);
  }
};

struct GpuiJsEngineInfo {
  std::string name;
  std::string version;
};

// Every capability an engine may provide. Only `info` and `makeRuntimeFactory`
// are required; core checks the optional members before use.
struct GpuiJsEngine {
  GpuiJsEngineInfo info;

  // Required. Creates the factory ReactHost uses for every (re)load.
  std::function<std::shared_ptr<facebook::react::JSRuntimeFactory>()>
      makeRuntimeFactory;

  // Optional. Loading stock Node-API `.node` addons. Creating a napi_env for a
  // runtime and loading a shared library into it are VM-specific, so the
  // engine supplies a loader; everything else (path resolution, the cache,
  // error messages) is core's. When missing, `_requireNodeLibrary` still
  // exists and throws an error naming the engine.
  struct NodeAddons {
    // Called once per runtime, on the JS thread, before the app bundle runs.
    // `jsInvoker` schedules work on that same JS thread. Returns a function
    // that loads the addon at an absolute path and returns its exports, or
    // throws a jsi::JSError with a readable message.
    std::function<std::function<facebook::jsi::Value(
        facebook::jsi::Runtime&,
        const std::string& absolutePath)>(
        std::shared_ptr<facebook::react::CallInvoker> jsInvoker)>
        makeLoader;
  };
  std::optional<NodeAddons> nodeAddons;

  // Optional. Returns the feature-flag overrides core installs. An engine that
  // needs flags of its own derives from GpuiFeatureFlagsOverrides and
  // overrides only those flags, so core's survive. When unset, core installs
  // GpuiFeatureFlagsOverrides itself.
  std::function<std::unique_ptr<
      facebook::react::ReactNativeFeatureFlagsOverridesOSSStable>()>
      makeFeatureFlagsOverrides;
};

// Called by engine packages from their registration function. Throws
// std::invalid_argument for an empty name, a duplicate name, or a missing
// runtime factory.
void registerJsEngine(GpuiJsEngine engine);

// Used by core. Throws std::runtime_error when no engine is registered, when
// several are registered and none was selected, or when the selected name is
// not registered.
const GpuiJsEngine& activeJsEngine();

std::vector<GpuiJsEngineInfo> registeredJsEngines();

// Chooses the engine for this run, before the host starts. An empty name
// returns to the default: the only registered engine, or an error when several
// are registered.
void selectJsEngine(std::string_view name);

} // namespace rngpui
