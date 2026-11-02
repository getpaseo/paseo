// Core has no built-in JS engine: an engine is an installed package that
// registers itself here.
#pragma once

#include <react/featureflags/ReactNativeFeatureFlagsOverridesOSSStable.h>

#include <jsi/jsi.h>

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
class GpuiFeatureFlagsOverrides
    : public facebook::react::ReactNativeFeatureFlagsOverridesOSSStable {
 public:
  // React Native's C++ AnimatedModule queues operations until
  // finishOperationBatch(). GPUI is neither Android nor iOS, so RN's JS helper
  // only sends those batch boundaries when this flag is enabled.
  bool cxxNativeAnimatedEnabled() override {
    return true;
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
