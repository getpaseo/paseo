#include "GpuiHost.h"
#include <react/runtime/GpuiDebug.h>

#include <jsi/instrumentation.h>
#include <react/coremodules/AppStateModule.h>
#include <react/coremodules/DeviceInfoModule.h>
#include "GpuiHttpClient.h"
#include "GpuiJsEngine.h"
#include "GpuiLogBoxSurfaceDelegate.h"
#include "GpuiLoomHost.h"
#include "GpuiMainMessageQueue.h"
#include "GpuiModules.h"
#include "GpuiMountingManager.h"
#include "GpuiNodeAddons.h"
#include "GpuiRustTurboModules.h"
#include "MountBatchBuilder.h"
#include "rn-gpui-sys/src/lib.rs.h" // cxx bridge

#include <folly/json.h>
#include <react/bridging/Function.h>
#include <react/bridging/Promise.h>
#include <react/featureflags/ReactNativeFeatureFlags.h>
#include <react/featureflags/ReactNativeFeatureFlagsOverridesOSSStable.h>
#include <react/http/IHttpClient.h>
#include <react/http/IWebSocketClient.h>
#include <react/renderer/animated/NativeAnimatedNodesManagerProvider.h>
#include <react/renderer/components/FBReactNativeSpec/FBReactNativeSpecJSI.h>
#include <react/renderer/runtimescheduler/RuntimeSchedulerBinding.h>
#include <react/renderer/runtimescheduler/RuntimeSchedulerCallInvoker.h>
#include <react/renderer/scheduler/Scheduler.h>
#include <react/runtime/PlatformTimerRegistryImpl.h>
#include <react/runtime/ReactHost.h>
#if LOOM_RENDERER
#include <react/renderer/loom/binding/LoomBinding.h>
#include <react/threading/MessageQueueThreadImpl.h>
#endif
#include <react/utils/ContextContainer.h>
#include <react/utils/RunLoopObserverManager.h>

#include <glog/logging.h>
#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <optional>
#include <unordered_map>
#include <utility>

namespace rngpui {
#if LOOM_RENDERER
// Loom takes a surface's constraints and the text scale from the host, next to
// the Fabric surface handler that still carries the surface's lifecycle.
void setLoomSurfaceConstraints(
    GpuiLoomHost& host,
    int32_t surfaceId,
    const facebook::react::LayoutConstraints& constraints,
    float scale) {
  host.setPointScaleFactor(scale);
  facebook::react::LoomBinding::setSurfaceConstraints(
      surfaceId,
      constraints.minimumSize.width,
      constraints.minimumSize.height,
      constraints.maximumSize.width,
      constraints.maximumSize.height,
      constraints.layoutDirection ==
          facebook::react::LayoutDirection::RightToLeft,
      0.f,
      0.f);
}
#endif
} // namespace rngpui

namespace {
facebook::react::LayoutDirection surfaceLayoutDirection() {
  return rngpui::rn_gpui_layout_direction_rtl()
      ? facebook::react::LayoutDirection::RightToLeft
      : facebook::react::LayoutDirection::LeftToRight;
}

std::atomic<bool> nativeAnimationActive{false};
} // namespace

extern "C" uint64_t rn_gpui_native_animations_active() noexcept {
  return nativeAnimationActive.load() ? 1 : 0;
}

namespace rngpui {
void updateFrameDemand() {
  rn_gpui_set_animated_active(
      nativeAnimationActive.load() || anyFrameRequested());
}
} // namespace rngpui

extern "C" uint64_t rn_gpui_frame_demand() noexcept {
  return rngpui::anyFrameRequested() ? 1 : 0;
}

extern "C" uint64_t rn_gpui_pending_work() noexcept {
  return rngpui::pendingWork();
}

extern "C" bool rn_gpui_accessibility_active();
#if defined(_MSC_VER)
// This hook lives in the rn-gpui Rust crate, which rn-gpui-sys does not depend
// on. An application links both, but rn-gpui-sys's own test binaries link only
// this crate, and MSVC has no weak symbols, so the reference would be
// unresolved (LNK2019). `alternatename` names a fallback used only while the
// symbol is otherwise undefined, so a real definition still wins wherever the
// crate is present.
extern "C" bool rn_gpui_accessibility_active_default() {
  return false;
}
#pragma comment( \
    linker,      \
    "/alternatename:rn_gpui_accessibility_active=rn_gpui_accessibility_active_default")
#endif

#if defined(__APPLE__) || defined(_WIN32) || defined(__linux__)
#define RN_GPUI_ACCESSIBILITY_SETTINGS 1
#endif

#if defined(RN_GPUI_ACCESSIBILITY_SETTINGS)
extern "C" bool rn_gpui_get_reduce_motion();
extern "C" bool rn_gpui_get_reduce_transparency();
extern "C" bool rn_gpui_get_increase_contrast();
extern "C" bool rn_gpui_get_invert_colors();
extern "C" bool rn_gpui_get_voice_over();
extern "C" void rn_gpui_announce_accessibility(
    const char* message,
    int priorityLevel);
extern "C" void rn_gpui_start_accessibility_observing();
extern "C" void rn_gpui_stop_accessibility_observing();
#endif

using namespace facebook::react;

namespace rngpui {
namespace {
std::mutex pointerEventMutex;
extension::RawPointerEvent lastPointerEvent{};
} // namespace

namespace {
std::atomic<GpuiHost*> activeGpuiHost{nullptr};

namespace jsi = facebook::jsi;
using AppCppTurboModuleProvider = std::shared_ptr<TurboModule> (*)(
    const std::string&,
    std::shared_ptr<CallInvoker>);
std::atomic<AppCppTurboModuleProvider> appCppTurboModuleProvider{nullptr};

std::mutex appearanceMutex;
std::string systemAppearance{"light"};
std::optional<std::string> appearanceOverride;

class GpuiAppearanceModule final
    : public NativeAppearanceCxxSpec<GpuiAppearanceModule> {
 public:
  explicit GpuiAppearanceModule(std::shared_ptr<CallInvoker> jsInvoker)
      : NativeAppearanceCxxSpec(std::move(jsInvoker)) {}

  facebook::jsi::String getColorScheme(facebook::jsi::Runtime& runtime) {
    std::lock_guard<std::mutex> lock(appearanceMutex);
    return facebook::jsi::String::createFromUtf8(
        runtime, appearanceOverride.value_or(systemAppearance));
  }

  void setColorScheme(facebook::jsi::Runtime&, std::string scheme) {
    std::string before;
    std::string after;
    {
      std::lock_guard<std::mutex> lock(appearanceMutex);
      before = appearanceOverride.value_or(systemAppearance);
      if (scheme == "light" || scheme == "dark") {
        appearanceOverride = std::move(scheme);
      } else {
        appearanceOverride.reset();
      }
      after = appearanceOverride.value_or(systemAppearance);
    }
    if (before != after) {
      for (const auto& observer :
           rngpui::gpuiExtensionHooks().colorSchemeObservers) {
        observer(after);
      }
    }
  }

  void addListener(facebook::jsi::Runtime&, std::string) {}
  void removeListeners(facebook::jsi::Runtime&, double) {}
};

class GpuiAccessibilityManagerModule final
    : public NativeAccessibilityManagerCxxSpec<GpuiAccessibilityManagerModule> {
 public:
  explicit GpuiAccessibilityManagerModule(
      std::shared_ptr<CallInvoker> jsInvoker)
      : NativeAccessibilityManagerCxxSpec(std::move(jsInvoker)) {}

  void getCurrentBoldTextState(
      jsi::Runtime& /*runtime*/,
      AsyncCallback<bool> onSuccess,
      AsyncCallback<jsi::Value> /*onError*/) {
    onSuccess(false);
  }
  void getCurrentGrayscaleState(
      jsi::Runtime& /*runtime*/,
      AsyncCallback<bool> onSuccess,
      AsyncCallback<jsi::Value> /*onError*/) {
    onSuccess(false);
  }
  void getCurrentInvertColorsState(
      jsi::Runtime& /*runtime*/,
      AsyncCallback<bool> onSuccess,
      AsyncCallback<jsi::Value> /*onError*/) {
#if defined(RN_GPUI_ACCESSIBILITY_SETTINGS)
    onSuccess(rn_gpui_get_invert_colors());
#else
    onSuccess(false);
#endif
  }
  void getCurrentReduceMotionState(
      jsi::Runtime& /*runtime*/,
      AsyncCallback<bool> onSuccess,
      AsyncCallback<jsi::Value> /*onError*/) {
#if defined(RN_GPUI_ACCESSIBILITY_SETTINGS)
    onSuccess(rn_gpui_get_reduce_motion());
#else
    onSuccess(false);
#endif
  }
  void getCurrentDarkerSystemColorsState(
      jsi::Runtime& /*runtime*/,
      AsyncCallback<bool> onSuccess,
      AsyncCallback<jsi::Value> /*onError*/) {
#if defined(RN_GPUI_ACCESSIBILITY_SETTINGS)
    onSuccess(rn_gpui_get_increase_contrast());
#else
    onSuccess(false);
#endif
  }
  void getCurrentPrefersCrossFadeTransitionsState(
      jsi::Runtime& /*runtime*/,
      AsyncCallback<bool> onSuccess,
      AsyncCallback<jsi::Value> /*onError*/) {
    onSuccess(false);
  }
  void getCurrentReduceTransparencyState(
      jsi::Runtime& /*runtime*/,
      AsyncCallback<bool> onSuccess,
      AsyncCallback<jsi::Value> /*onError*/) {
#if defined(RN_GPUI_ACCESSIBILITY_SETTINGS)
    onSuccess(rn_gpui_get_reduce_transparency());
#else
    onSuccess(false);
#endif
  }
  void getCurrentVoiceOverState(
      jsi::Runtime& /*runtime*/,
      AsyncCallback<bool> onSuccess,
      AsyncCallback<jsi::Value> /*onError*/) {
#if defined(__APPLE__)
    onSuccess(rn_gpui_get_voice_over());
#elif defined(RN_GPUI_ACCESSIBILITY_SETTINGS)
    onSuccess(rn_gpui_get_voice_over() || rn_gpui_accessibility_active());
#else
    onSuccess(rn_gpui_accessibility_active());
#endif
  }
  void setAccessibilityContentSizeMultipliers(
      jsi::Runtime& /*runtime*/,
      jsi::Object /*multipliers*/) {}
  void setAccessibilityFocus(jsi::Runtime& /*runtime*/, double reactTag) {
    rn_gpui_request_accessibility_focus(static_cast<int32_t>(reactTag));
  }
  void announceForAccessibility(
      jsi::Runtime& runtime,
      jsi::String announcement) {
#if defined(RN_GPUI_ACCESSIBILITY_SETTINGS)
    auto text = announcement.utf8(runtime);
    rn_gpui_announce_accessibility(text.c_str(), 1);
#endif
  }
  void announceForAccessibilityWithOptions(
      jsi::Runtime& runtime,
      jsi::String announcement,
      jsi::Object options) {
#if defined(RN_GPUI_ACCESSIBILITY_SETTINGS)
    auto text = announcement.utf8(runtime);
    const auto queue = options.getProperty(runtime, "queue");
    int priorityLevel = queue.isBool() && queue.getBool() ? 0 : 1;
    const auto priority = options.getProperty(runtime, "priority");
    if (priority.isString()) {
      const auto name = priority.asString(runtime).utf8(runtime);
      if (name == "high")
        priorityLevel = 2;
      else if (name == "low")
        priorityLevel = 0;
      else if (name == "default")
        priorityLevel = 1;
    }
    rn_gpui_announce_accessibility(text.c_str(), priorityLevel);
#endif
  }
};

class GpuiAccessibilityInfoModule final
    : public NativeAccessibilityInfoCxxSpec<GpuiAccessibilityInfoModule> {
 public:
  explicit GpuiAccessibilityInfoModule(std::shared_ptr<CallInvoker> jsInvoker)
      : NativeAccessibilityInfoCxxSpec(std::move(jsInvoker)) {}

  void isReduceMotionEnabled(jsi::Runtime&, AsyncCallback<bool> callback) {
#if defined(RN_GPUI_ACCESSIBILITY_SETTINGS)
    callback(rn_gpui_get_reduce_motion());
#else
    callback(false);
#endif
  }
  void isInvertColorsEnabled(jsi::Runtime&, AsyncCallback<bool> callback) {
#if defined(RN_GPUI_ACCESSIBILITY_SETTINGS)
    callback(rn_gpui_get_invert_colors());
#else
    callback(false);
#endif
  }
  void isHighTextContrastEnabled(jsi::Runtime&, AsyncCallback<bool> callback) {
#if defined(RN_GPUI_ACCESSIBILITY_SETTINGS)
    callback(rn_gpui_get_increase_contrast());
#else
    callback(false);
#endif
  }
  void isTouchExplorationEnabled(jsi::Runtime&, AsyncCallback<bool> callback) {
    // Desktop pointer/keyboard accessibility is not equivalent to touch
    // exploration; AccessKit currently has no portable screen-reader query.
    callback(false);
  }
  void isAccessibilityServiceEnabled(
      jsi::Runtime&,
      AsyncCallback<bool> callback) {
    callback(false);
  }
  void setAccessibilityFocus(jsi::Runtime&, double reactTag) {
    rn_gpui_request_accessibility_focus(static_cast<int32_t>(reactTag));
  }
  void announceForAccessibility(jsi::Runtime& runtime, jsi::String text) {
#if defined(RN_GPUI_ACCESSIBILITY_SETTINGS)
    const auto announcement = text.utf8(runtime);
    rn_gpui_announce_accessibility(announcement.c_str(), 1);
#endif
  }
  void getRecommendedTimeoutMillis(
      jsi::Runtime&,
      double timeout,
      AsyncCallback<double> callback) {
    callback(timeout);
  }
  void isGrayscaleEnabled(jsi::Runtime&, AsyncCallback<bool> callback) {
    callback(false);
  }
};

extern "C" void rn_gpui_request_reload();

/// Thin C shim so the vendored `DevSettingsModule` (ReactCxxPlatform) can reach
/// the same Rust handler without depending on the cxx bridge header.
extern "C" void rn_gpui_dev_settings_changed(const char* name, bool enabled) {
  if (name != nullptr) {
    rn_gpui_dev_setting(rust::String(name), enabled);
  }
}

extern "C" void rn_gpui_set_app_cpp_turbo_module_provider(
    AppCppTurboModuleProvider provider) {
  appCppTurboModuleProvider.store(provider, std::memory_order_release);
}

TurboModuleProviders gpui_turbo_module_providers() {
  return {
      [](const std::string& name, const std::shared_ptr<CallInvoker>& jsInvoker)
          -> std::shared_ptr<TurboModule> {
        if (auto provider =
                appCppTurboModuleProvider.load(std::memory_order_acquire)) {
          if (auto appModule = provider(name, jsInvoker)) {
            return appModule;
          }
        }
        for (const auto& extensionProvider :
             rngpui::gpuiModuleHooks().turboModules) {
          if (auto extensionModule = extensionProvider(name, jsInvoker)) {
            return extensionModule;
          }
        }
        if (name ==
            NativeAppearanceCxxSpec<GpuiAppearanceModule>::kModuleName) {
          return std::make_shared<GpuiAppearanceModule>(jsInvoker);
        }
        if (name ==
            NativeAccessibilityManagerCxxSpec<
                GpuiAccessibilityManagerModule>::kModuleName) {
          return std::make_shared<GpuiAccessibilityManagerModule>(jsInvoker);
        }
        if (name ==
            NativeAccessibilityInfoCxxSpec<
                GpuiAccessibilityInfoModule>::kModuleName) {
          return std::make_shared<GpuiAccessibilityInfoModule>(jsInvoker);
        }
        return nullptr;
      }};
}

// Installs the OSS stable feature flags, which is what an OSS app on the new
// (bridgeless) architecture does. `enableBridgelessArchitecture` is load
// bearing for us: ReactHost here IS the bridgeless host, and an engine is
// expected to enable its microtask queue when that flag is on; without it,
// React's rendering path fails with "Could not enqueue microtask because they
// are disabled in this runtime".
void install_feature_flags() {
  static std::once_flag once;
  std::call_once(once, [] {
    // An engine that needs flags of its own returns an overrides object
    // deriving from rngpui::GpuiFeatureFlagsOverrides, so core's survive.
    const auto& engine = rngpui::activeJsEngine();
    std::unique_ptr<ReactNativeFeatureFlagsOverridesOSSStable> overrides;
    if (engine.makeFeatureFlagsOverrides) {
      overrides = engine.makeFeatureFlagsOverrides();
    }
    if (!overrides) {
      overrides = std::make_unique<rngpui::GpuiFeatureFlagsOverrides>();
    }
    ReactNativeFeatureFlags::override(std::move(overrides));
  });
}
} // namespace

std::unique_ptr<GpuiHost> new_gpui_host(
    rust::Str appId,
    rust::Str devHost,
    uint32_t devPort,
    rust::Str jsEngine,
    rust::Str jsThread,
    bool devMode) {
  return std::make_unique<GpuiHost>(
      appId, devHost, devPort, jsEngine, jsThread, devMode);
}

GpuiHost::GpuiHost(
    rust::Str appId,
    rust::Str devHost,
    uint32_t devPort,
    rust::Str jsEngine,
    rust::Str jsThread,
    bool devMode) {
  // Engine packages register themselves here (the generated
  // rn_gpui_install_modules()), so the registry is populated before the
  // app's choice (`RN_GPUI_JS_ENGINE` / DesktopAppConfig::js_engine) is applied
  // and before anything asks for the active engine. The Rust TurboModule
  // provider is always present, so it installs its hook alongside them.
  rngpui::install_rust_turbo_modules();
  rngpui::rn_gpui_install_modules();
  rngpui::selectJsEngine(std::string(jsEngine));
#if LOOM_RENDERER
  rngpui::sharedAnimatedBackend().store(true, std::memory_order_release);
#endif
  install_feature_flags();
  rngpui::installGpuiTextMeasureTable();
  rngpui::installGpuiImageLoadTable();

  ReactInstanceConfig config;
  config.appId = std::string(appId);
  config.deviceName = "rn-gpui";
  config.devServerHost = std::string(devHost);
  config.devServerPort = devPort;
  // Dev mode is decided at runtime by the caller (the app's Cargo profile, or
  // RN_GPUI_DEV_MODE), not by REACT_NATIVE_DEBUG. The prebuilt runtime is built
  // in Release, so a macro default here would send every debug app that links
  // it to the on-disk bundle instead of Metro.
  config.enableDevMode = devMode;
  config.enableInspector = devMode;
  if (std::getenv("RN_GPUI_TEST_DRIVER")) {
    const auto* mode = std::getenv("RN_GPUI_TEST_MODE");
    if (mode && std::string_view(mode) == "metro")
      config.enableDevMode = true;
  }
  config.platformTimerRegistryFactory = [] {
    return std::make_unique<PlatformTimerRegistryImpl>();
  };
  config.jsRuntimeFactory = rngpui::activeJsEngine().makeRuntimeFactory();

#if LOOM_RENDERER
  // Loom keeps the surface tree itself: nothing mounts through the shadow tree,
  // so there is no mount to report and the root's size is Loom's to answer.
  mountingManager_ = std::make_shared<GpuiMountingManager>(
      nullptr, [this](SurfaceId surfaceId) {
        return loomHost_->surfaceContentSize(surfaceId);
      });
#else
  mountingManager_ = std::make_shared<GpuiMountingManager>(
      [this](SurfaceId surfaceId) {
        reactHost_->runOnScheduler([surfaceId](Scheduler& scheduler) {
          scheduler.reportMount(surfaceId);
        });
      },
      [this](SurfaceId surfaceId) {
        return reactHost_->surfaceContentSize(surfaceId);
      });
#endif

  rngpui::setHostComponentStateManager(mountingManager_);

  // ReactHost's constructor throws unless both factories are in the
  // ContextContainer.
  auto contextContainer = std::make_shared<const ContextContainer>();
  contextContainer->insert(HttpClientFactoryKey, gpui_http_client_factory());
  contextContainer->insert(
      WebSocketClientFactoryKey, getWebSocketClientFactory());
  contextContainer->insert(
      "RCTImageLoader",
      std::static_pointer_cast<void>(mountingManager_->getImageLoader()));

#if LOOM_RENDERER
  // Fixed before the runtime scheduler or any binding reads it; unset, Loom
  // runs JavaScript on the UI thread.
  const bool jsOnMain = std::string(jsThread) == "main";
  LoomHost::setJavaScriptOnUIThread(jsOnMain);
  // Registered before the JS runtime installs its binding, which reads it.
  loomHost_ = std::make_shared<GpuiLoomHost>(
      mountingManager_,
      contextContainer,
      [this](std::function<void(Scheduler&)>&& task) {
        if (reactHost_) {
          reactHost_->runOnScheduler(std::move(task));
        }
      },
      [this](std::function<void()>&& task) {
        if (reactHost_) {
          reactHost_->runOnRuntimeScheduler(
              [task = std::move(task)](facebook::jsi::Runtime&) { task(); });
        }
      });
  loomHost_->connect();
  LoomHost::registerIn(*contextContainer, loomHost_);
  loomHost_->installSizeHints();
  mountingManager_->setInstanceHook([this](bool up) {
    if (up) {
      loomHost_->begin();
    } else {
      loomHost_->reset();
    }
  });
  if (jsOnMain) {
    contextContainer->insert(
        MessageQueueThreadFactoryKey, MessageQueueThreadFactory([] {
          return std::make_shared<GpuiMainMessageQueue>();
        }));
  }
#endif

  runLoopObserverManager_ = std::make_shared<RunLoopObserverManager>();

  config.animatedNodesManagerProviderFactory = [this] {
    return std::make_shared<NativeAnimatedNodesManagerProvider>(
        [this](std::function<void()>&& callback, bool /*isAsync*/) {
          if (gpuiDebugAnimationEnabled()) {
            LOG(INFO) << "[native-animated] frame callback started";
          }
          {
            std::lock_guard<std::recursive_mutex> lock(animatedFrameMutex_);
            animatedFrameCallback_ = std::move(callback);
          }
          nativeAnimationActive.store(true);
          rngpui::updateFrameDemand();
        },
        [this](bool /*isAsync*/) {
          if (gpuiDebugAnimationEnabled()) {
            LOG(INFO) << "[native-animated] frame callback stopped";
          }
          {
            std::lock_guard<std::recursive_mutex> lock(animatedFrameMutex_);
            animatedFrameCallback_ = nullptr;
          }
          nativeAnimationActive.store(false);
          rngpui::updateFrameDemand();
        });
  };
  config.beforeInstanceDestroy = [this] {
    // Wait for a frame already executing on GPUI, then prevent callbacks into
    // the old graph while ReactHost tears down its runtime and UIManager.
    std::lock_guard<std::recursive_mutex> lock(animatedFrameMutex_);
    animatedFrameCallback_ = nullptr;
    nativeAnimationActive.store(false);
#if LOOM_RENDERER
    if (loomHost_) {
      loomHost_->animationFrameSource()->pause();
    }
#endif
    rngpui::updateFrameDemand();
  };

  // The LogBox surface. ReactHost hands this to
  // `ReactCxxTurboModuleProvider`, which builds `LogBoxModule` only when the
  // delegate is set (`ReactCxxTurboModuleProvider.cpp`); without it the JS side
  // logs "Failed to load TurboModule: LogBox" and no red box appears.
  logBoxDelegate_ = std::make_shared<GpuiLogBoxSurfaceDelegate>(*this);

  reactHost_ = std::make_unique<ReactHost>(
      config,
      mountingManager_,
      runLoopObserverManager_,
      std::move(contextContainer),
      /* onJsError */
      [](facebook::jsi::Runtime&, const JsErrorHandler::ProcessedError& error) {
        rn_gpui_log(3, error.message);
        for (const auto& frame : error.stack) {
          std::string entry = "  at " + frame.methodName;
          if (frame.file)
            entry += " (" + *frame.file;
          if (frame.lineNumber)
            entry += ":" + std::to_string(*frame.lineNumber);
          if (frame.column)
            entry += ":" + std::to_string(*frame.column);
          if (frame.file)
            entry += ")";
          rn_gpui_log(3, entry);
        }
      },
      /* logger */
      [](const std::string& message, unsigned int level) {
        rn_gpui_log(static_cast<int32_t>(level), message);
      },
      /* devUIDelegate */ nullptr,
      /* turboModuleProviders */ gpui_turbo_module_providers(),
      /* logBoxSurfaceDelegate */ logBoxDelegate_,
      /* animatedNodesManagerProvider */ animatedNodesManagerProvider_,
      /* bindingsInstallFunc */
      [this](facebook::jsi::Runtime& runtime) {
#if LOOM_RENDERER
        // A new instance has a new animation backend that has started nothing:
        // an animation of the old one that resumed the frame source as it was
        // torn down is not running any more.
        if (loomHost_) {
          loomHost_->animationFrameSource()->pause();
        }
#endif
        runtime.global().setProperty(
            runtime, "__gpuiScrollerLegacy", rn_gpui_scroller_legacy());
        // A native tree's batch of operations, from the second reconciler.
        runtime.global().setProperty(
            runtime,
            "__gpuiNativeRootApply",
            facebook::jsi::Function::createFromHostFunction(
                runtime,
                facebook::jsi::PropNameID::forAscii(
                    runtime, "__gpuiNativeRootApply"),
                2,
                [](facebook::jsi::Runtime& rt,
                   const facebook::jsi::Value&,
                   const facebook::jsi::Value* args,
                   size_t count) -> facebook::jsi::Value {
                  if (count >= 2 && args[0].isNumber() && args[1].isString()) {
                    rn_gpui_native_root_ops(
                        static_cast<uint32_t>(args[0].asNumber()),
                        args[1].asString(rt).utf8(rt));
                  }
                  return facebook::jsi::Value::undefined();
                }));
        // `_requireNodeLibrary` must exist before the app bundle runs, and a
        // reload creates a new runtime, so it is installed here rather than at
        // module-registration time. ReactInstance installs the
        // RuntimeSchedulerBinding just before calling this, which is the same
        // CallInvoker the TurboModules get; a fresh one per runtime is correct,
        // because the engine's host callbacks belong to that runtime.
        auto binding =
            facebook::react::RuntimeSchedulerBinding::getBinding(runtime);
        if (!binding) {
          return;
        }
        rngpui::installNodeAddons(
            runtime,
            std::make_shared<facebook::react::RuntimeSchedulerCallInvoker>(
                binding->getRuntimeScheduler()));
      },
#if LOOM_RENDERER
      /* animationChoreographer */ loomHost_->animationFrameSource()
#else
      /* animationChoreographer */ nullptr
#endif
  );
  activeGpuiHost.store(this, std::memory_order_release);
#if defined(RN_GPUI_ACCESSIBILITY_SETTINGS)
  rn_gpui_start_accessibility_observing();
#endif
}

GpuiHost::~GpuiHost() {
#if defined(RN_GPUI_ACCESSIBILITY_SETTINGS)
  rn_gpui_stop_accessibility_observing();
#endif
  reactHost_->stopAllSurfaces();
  for (const auto& listener : eventListeners_) {
    reactHost_->runOnScheduler([&listener](Scheduler& scheduler) {
      scheduler.removeEventListener(listener);
    });
  }
  auto* expected = this;
  activeGpuiHost.compare_exchange_strong(
      expected, nullptr, std::memory_order_acq_rel);
}

std::shared_ptr<UIManager> GpuiHost::ui_manager() const {
  std::shared_ptr<UIManager> result;
  reactHost_->runOnScheduler(
      [&result](Scheduler& scheduler) { result = scheduler.getUIManager(); });
  return result;
}

void GpuiHost::synchronously_update_props(
    int32_t tag,
    const folly::dynamic& props) const {
  mountingManager_->synchronouslyUpdateViewOnUIThread(tag, props);
}

void GpuiHost::add_event_listener(
    std::shared_ptr<const EventListener> listener) {
  reactHost_->runOnScheduler([&listener](Scheduler& scheduler) {
    scheduler.addEventListener(listener);
  });
  eventListeners_.push_back(std::move(listener));
}

std::shared_ptr<UIManager> get_gpui_ui_manager() {
  auto* host = activeGpuiHost.load(std::memory_order_acquire);
  return host ? host->ui_manager() : nullptr;
}

void gpui_synchronously_update_props(int32_t tag, const folly::dynamic& props) {
  if (auto* host = activeGpuiHost.load(std::memory_order_acquire)) {
    host->synchronously_update_props(tag, props);
  }
}

void register_gpui_event_listener(
    std::shared_ptr<const EventListener> listener) {
  if (auto* host = activeGpuiHost.load(std::memory_order_acquire)) {
    host->add_event_listener(std::move(listener));
  }
}

bool GpuiHost::load_script(rust::Str bundlePath, rust::Str sourceUrl) {
  scriptLoaded_ =
      reactHost_->loadScript(std::string(bundlePath), std::string(sourceUrl));
  return scriptLoaded_;
}

namespace {
/// Fabric asserts on an undefined constraint, so every bound is a real number
/// and the pair is ordered: a caller that asks for a range wider than its
/// content still gets a valid constraint.
facebook::react::LayoutConstraints constraintsFrom(
    float minWidth,
    float minHeight,
    float maxWidth,
    float maxHeight,
    float /*scale*/) {
  facebook::react::LayoutConstraints constraints;
  const float minW = std::max(0.f, minWidth);
  const float minH = std::max(0.f, minHeight);
  const float maxW = std::max(minW, maxWidth);
  const float maxH = std::max(minH, maxHeight);
  constraints.minimumSize = {minW, minH};
  constraints.maximumSize = {maxW, maxH};
  constraints.layoutDirection = surfaceLayoutDirection();
  return constraints;
}
} // namespace

void GpuiHost::start_surface(
    int32_t id,
    rust::Str module,
    float w,
    float h,
    float scale) {
  start_surface_with_props(id, module, rust::Str("{}"), w, h, scale);
}

void GpuiHost::start_surface_with_props(
    int32_t id,
    rust::Str module,
    rust::Str propsJson,
    float w,
    float h,
    float scale) {
  LayoutConstraints constraints;
  constraints.minimumSize = {w, h};
  constraints.maximumSize = {w, h};
  // SurfaceHandler asserts on Undefined.
  constraints.layoutDirection = surfaceLayoutDirection();
  LayoutContext context;
  context.pointScaleFactor = scale;
  context.fontSizeMultiplier = DeviceInfoModule::fontScale();
  context.swapLeftAndRightInRTL = rngpui::rn_gpui_swap_left_and_right_in_rtl();
  if (id == kAppSurfaceId) {
    surfaceWidth_ = w;
    surfaceHeight_ = h;
    surfaceScale_ = scale;
    mountingManager_->setWindowSize(w, h);
  }
  folly::dynamic initialProps = folly::dynamic::object();
  const auto props = std::string(propsJson);
  if (!props.empty()) {
    auto parsed = folly::parseJson(props);
    if (!parsed.isObject())
      throw std::invalid_argument("Surface initialProps must be an object");
    initialProps = std::move(parsed);
  }
  if (id == kAppSurfaceId && std::getenv("RN_GPUI_TEST_DRIVER")) {
    if (const char* value = std::getenv("RN_GPUI_TEST_INITIAL_PROPS")) {
      initialProps = folly::parseJson(value);
      if (!initialProps.isObject())
        throw std::invalid_argument("Test initialProps must be an object");
    }
  }
#if LOOM_RENDERER
  setLoomSurfaceConstraints(*loomHost_, id, constraints, scale);
#endif
  reactHost_->startSurface(
      id, std::string(module), initialProps, constraints, context);
}

void GpuiHost::start_surface_with_constraints(
    int32_t id,
    rust::Str module,
    rust::Str propsJson,
    float minWidth,
    float minHeight,
    float maxWidth,
    float maxHeight,
    float scale) {
  LayoutConstraints constraints =
      constraintsFrom(minWidth, minHeight, maxWidth, maxHeight, scale);
  LayoutContext context;
  context.pointScaleFactor = scale;
  context.fontSizeMultiplier = DeviceInfoModule::fontScale();
  context.swapLeftAndRightInRTL = rngpui::rn_gpui_swap_left_and_right_in_rtl();
  if (id == kAppSurfaceId) {
    surfaceWidth_ = maxWidth;
    surfaceHeight_ = maxHeight;
    surfaceScale_ = scale;
    mountingManager_->setWindowSize(maxWidth, maxHeight);
  }
  folly::dynamic initialProps = folly::dynamic::object();
  const auto props = std::string(propsJson);
  if (!props.empty()) {
    auto parsed = folly::parseJson(props);
    if (!parsed.isObject())
      throw std::invalid_argument("Surface initialProps must be an object");
    initialProps = std::move(parsed);
  }
#if LOOM_RENDERER
  setLoomSurfaceConstraints(*loomHost_, id, constraints, scale);
#endif
  reactHost_->startSurface(
      id, std::string(module), initialProps, constraints, context);
}

void GpuiHost::set_surface_constraints(
    int32_t id,
    float minWidth,
    float minHeight,
    float maxWidth,
    float maxHeight,
    float scale) {
  LayoutConstraints constraints =
      constraintsFrom(minWidth, minHeight, maxWidth, maxHeight, scale);
  LayoutContext context;
  context.pointScaleFactor = scale;
  context.fontSizeMultiplier = DeviceInfoModule::fontScale();
  context.swapLeftAndRightInRTL = rngpui::rn_gpui_swap_left_and_right_in_rtl();
  if (id == kAppSurfaceId) {
    surfaceWidth_ = maxWidth;
    surfaceHeight_ = maxHeight;
    surfaceScale_ = scale;
    mountingManager_->setWindowSize(maxWidth, maxHeight);
  }
#if LOOM_RENDERER
  setLoomSurfaceConstraints(*loomHost_, id, constraints, scale);
#endif
  reactHost_->setSurfaceConstraints(id, constraints, context);
}

void GpuiHost::set_surface_size(int32_t id, float w, float h, float scale) {
  LayoutConstraints constraints;
  constraints.minimumSize = {w, h};
  constraints.maximumSize = {w, h};
  constraints.layoutDirection = surfaceLayoutDirection();
  LayoutContext context;
  context.pointScaleFactor = scale;
  context.fontSizeMultiplier = DeviceInfoModule::fontScale();
  context.swapLeftAndRightInRTL = rngpui::rn_gpui_swap_left_and_right_in_rtl();
  if (id == kAppSurfaceId) {
    surfaceWidth_ = w;
    surfaceHeight_ = h;
    surfaceScale_ = scale;
    mountingManager_->setWindowSize(w, h);
  }
#if LOOM_RENDERER
  setLoomSurfaceConstraints(*loomHost_, id, constraints, scale);
#endif
  reactHost_->setSurfaceConstraints(id, constraints, context);
  if (id == kAppSurfaceId) {
    set_window_metrics(w, h, scale);
  }
}

void GpuiHost::set_window_top_inset(float top) {
  mountingManager_->setWindowTopInset(top);
}

void GpuiHost::set_window_metrics(float w, float h, float scale) {
  if (!DeviceInfoModule::setWindowMetrics(w, h, scale)) {
    return;
  }
  for (const auto& observer : gpuiExtensionHooks().windowMetricsObservers) {
    observer();
  }
  if (!scriptLoaded_) {
    return;
  }
  emitDimensions();
}

void GpuiHost::emitDimensions() const {
  const auto windowSize = DeviceInfoModule::windowSize();
  const auto screenSize = DeviceInfoModule::screenSize();
  const double scale = surfaceScale_;
  const double fontScale = DeviceInfoModule::fontScale();
  const folly::dynamic window =
      folly::dynamic::object("width", windowSize.width)(
          "height", windowSize.height)("scale", scale)("fontScale", fontScale);
  const folly::dynamic screen =
      folly::dynamic::object("width", screenSize.width)(
          "height", screenSize.height)("scale", scale)("fontScale", fontScale);
  folly::dynamic payload =
      folly::dynamic::object("window", window)("screen", screen);
  reactHost_->emitDeviceEvent(
      folly::dynamic::array("didUpdateDimensions", std::move(payload)));
}

void GpuiHost::set_display_metrics(
    float screenWidth,
    float screenHeight,
    float fontScale) {
  const bool fontScaleChanged = DeviceInfoModule::fontScale() != fontScale;
  if (!DeviceInfoModule::setDisplayMetrics(
          screenWidth, screenHeight, fontScale)) {
    return;
  }
  for (const auto& observer : gpuiExtensionHooks().windowMetricsObservers) {
    observer();
  }
  if (!scriptLoaded_) {
    return;
  }
  if (fontScaleChanged && surfaceWidth_ > 0.f) {
    set_surface_size(
        kAppSurfaceId, surfaceWidth_, surfaceHeight_, surfaceScale_);
  }
  emitDimensions();
}

void GpuiHost::emit_device_event(rust::Str eventName) const {
  if (!scriptLoaded_)
    return;
  const auto timestamp =
      std::chrono::duration<double, std::milli>(
          std::chrono::steady_clock::now().time_since_epoch())
          .count();
  reactHost_->emitDeviceEvent(folly::dynamic::array(
      std::string(eventName), folly::dynamic::object("timeStamp", timestamp)));
}

void GpuiHost::emit_device_event_bool(rust::Str eventName, bool value) const {
  if (scriptLoaded_) {
    reactHost_->emitDeviceEvent(
        folly::dynamic::array(std::string(eventName), value));
  }
}

void GpuiHost::emit_device_event_json(
    rust::Str eventName,
    rust::Str payloadJson) const {
  if (!scriptLoaded_)
    return;
  folly::dynamic payload = folly::dynamic::object();
  try {
    auto parsed = folly::parseJson(std::string(payloadJson));
    if (parsed.isObject()) {
      payload = std::move(parsed);
    }
  } catch (const std::exception& error) {
    LOG(WARNING) << "emit_device_event_json(" << std::string(eventName)
                 << "): invalid payload: " << error.what();
  }
  reactHost_->emitDeviceEvent(
      folly::dynamic::array(std::string(eventName), std::move(payload)));
}

void GpuiHost::set_app_state(rust::Str state) {
  const std::string next(state);
  const std::string previous = AppStateModule::state();
  if (next == previous) {
    return;
  }
  AppStateModule::setState(next);
  if (!scriptLoaded_) {
    return;
  }
  reactHost_->emitDeviceEvent(folly::dynamic::array(
      "appStateDidChange", folly::dynamic::object("app_state", next)));
  if ((next == "active") != (previous == "active")) {
    reactHost_->emitDeviceEvent(
        folly::dynamic::array("appStateFocusChange", next == "active"));
  }
}

void GpuiHost::emit_memory_warning() const {
  if (scriptLoaded_) {
    reactHost_->emitDeviceEvent(folly::dynamic::array("memoryWarning"));
  }
}

void GpuiHost::emit_accessibility_setting_event(
    const std::string& eventName,
    bool enabled) const {
  if (scriptLoaded_) {
    reactHost_->emitDeviceEvent(folly::dynamic::array(eventName, enabled));
  }
}

#if defined(RN_GPUI_ACCESSIBILITY_SETTINGS)
extern "C" void rn_gpui_accessibility_setting_changed(
    const char* eventName,
    bool enabled) {
  auto* host = activeGpuiHost.load(std::memory_order_acquire);
  if (host != nullptr && eventName != nullptr) {
    host->emit_accessibility_setting_event(eventName, enabled);
  }
}
#endif

void GpuiHost::set_system_appearance(rust::Str appearance) {
  bool shouldNotify = false;
  bool effectiveChanged = false;
  std::string nextAppearance;
  {
    std::lock_guard<std::mutex> lock(appearanceMutex);
    nextAppearance = std::string(appearance) == "dark" ? "dark" : "light";
    if (systemAppearance == nextAppearance)
      return;
    systemAppearance = nextAppearance;
    effectiveChanged = !appearanceOverride.has_value();
    shouldNotify = effectiveChanged && scriptLoaded_;
  }
  if (effectiveChanged) {
    for (const auto& observer : gpuiExtensionHooks().colorSchemeObservers) {
      observer(nextAppearance);
    }
  }
  if (shouldNotify) {
    folly::dynamic preferences =
        folly::dynamic::object("colorScheme", nextAppearance);
    reactHost_->emitDeviceEvent(
        folly::dynamic::array("appearanceChanged", std::move(preferences)));
  }
}

void GpuiHost::open_debugger() const {
  reactHost_->openDebugger();
}

namespace {
// Static, so a probe that outlives a reload or the host touches nothing that
// has been destroyed.
std::atomic<uint64_t> jsHeapBytes{0};

/// The engine's own figure for "bytes allocated on the JS heap". JSI leaves
/// the keys of `getHeapInfo` to each engine, which prefix them with their
/// name, so this goes by the suffix instead of naming an engine.
uint64_t sampleJsHeapBytes(facebook::jsi::Runtime& runtime) {
  uint64_t allocated = 0;
  uint64_t size = 0;
  try {
    for (const auto& [key, value] :
         runtime.instrumentation().getHeapInfo(false)) {
      if (value <= 0) {
        continue;
      }
      if (key.ends_with("allocatedBytes")) {
        allocated = static_cast<uint64_t>(value);
      } else if (key.ends_with("heapSize")) {
        size = static_cast<uint64_t>(value);
      }
    }
  } catch (...) {
  }
  return allocated != 0 ? allocated : size;
}
} // namespace

uint64_t GpuiHost::js_frame_probe() const {
  static std::atomic<uint64_t> completed{0};
  static std::atomic<bool> pending{false};
  if (scriptLoaded_ && !reactHost_->isReloading() && !pending.exchange(true)) {
    reactHost_->runOnRuntimeScheduler([](facebook::jsi::Runtime& runtime) {
      static std::chrono::steady_clock::time_point sampledAt{};
      const auto now = std::chrono::steady_clock::now();
      if (now - sampledAt >= std::chrono::milliseconds(500)) {
        sampledAt = now;
        jsHeapBytes.store(
            sampleJsHeapBytes(runtime), std::memory_order_relaxed);
      }
      completed.fetch_add(1, std::memory_order_relaxed);
      pending.store(false);
    });
  }
  return completed.load(std::memory_order_relaxed);
}

uint64_t GpuiHost::js_heap_bytes() const {
  return jsHeapBytes.load(std::memory_order_relaxed);
}

void GpuiHost::stop_surface(int32_t id) {
#if LOOM_RENDERER
  LoomBinding::releaseSurface(id);
#endif
  reactHost_->stopSurface(id);
  // Fabric emits no Delete mutations for a surface that is torn down, so the
  // store has to drop it explicitly.
  rn_gpui_on_surface_stopped(id);
}

void GpuiHost::request_reload() {
  reactHost_->requestReload();
}
bool GpuiHost::set_dev_server(rust::Str host, uint32_t port) {
  return reactHost_->setDevServer(std::string(host), port);
}
rust::String GpuiHost::dev_server_address() const {
  return rust::String(reactHost_->devServerAddress());
}
bool GpuiHost::reload_in_progress() const {
  return reactHost_->isReloading();
}
uint64_t GpuiHost::instance_generation() const {
  return reactHost_->instanceGeneration();
}
extern "C" void rn_gpui_request_reload() {
  if (auto* host = activeGpuiHost.load())
    host->request_reload();
}
extern "C" bool rn_gpui_reload_in_progress() {
  if (auto* host = activeGpuiHost.load())
    return host->reload_in_progress();
  return false;
}
extern "C" uint64_t rn_gpui_instance_generation() {
  if (auto* host = activeGpuiHost.load())
    return host->instance_generation();
  return 0;
}

void GpuiHost::start_log_box_surface() {
  LayoutConstraints constraints;
  constraints.minimumSize = {surfaceWidth_, surfaceHeight_};
  constraints.maximumSize = {surfaceWidth_, surfaceHeight_};
  constraints.layoutDirection = surfaceLayoutDirection();
  LayoutContext context;
  context.pointScaleFactor = surfaceScale_;
  context.fontSizeMultiplier = DeviceInfoModule::fontScale();
  context.swapLeftAndRightInRTL = rngpui::rn_gpui_swap_left_and_right_in_rtl();
#if LOOM_RENDERER
  setLoomSurfaceConstraints(
      *loomHost_, kLogBoxSurfaceId, constraints, surfaceScale_);
#endif
  reactHost_->startSurface(
      kLogBoxSurfaceId,
      "LogBox",
      folly::dynamic::object(),
      constraints,
      context);
}

/// Stop the LogBox surface again: `hide()` is what keeps a closed
/// LogBox from covering the app surface with an empty full-size overlay.
void GpuiHost::stop_log_box_surface() {
#if LOOM_RENDERER
  LoomBinding::releaseSurface(kLogBoxSurfaceId);
#endif
  reactHost_->stopSurface(kLogBoxSurfaceId);
  rn_gpui_on_surface_stopped(kLogBoxSurfaceId);
}

void GpuiHost::on_render() const {
  std::lock_guard<std::recursive_mutex> lock(animatedFrameMutex_);
  if (reactHost_->isReloading())
    return;
  runLoopObserverManager_->onRender();
}

namespace {
void dispatchPointerTick(
    GpuiMountingManager& mountingManager,
    double eventTimestampMs) {
  if (gpuiExtensionHooks().pointerObservers.empty())
    return;
  extension::RawPointerEvent tick;
  {
    std::lock_guard<std::mutex> lock(pointerEventMutex);
    tick = lastPointerEvent;
  }
  tick.phase = 4; // native time tick for duration-based recognizers
  tick.timestamp = eventTimestampMs;
  for (const auto& observer : gpuiExtensionHooks().pointerObservers) {
    for (const auto& recognized : observer(tick)) {
      mountingManager.dispatchEvent(
          recognized.targetTag,
          recognized.eventType,
          folly::parseJson(recognized.payloadJson));
    }
  }
}
} // namespace

void GpuiHost::on_pointer_frame(double eventTimestampMs) const {
  std::lock_guard<std::recursive_mutex> lock(animatedFrameMutex_);
  if (reactHost_->isReloading())
    return;
  dispatchPointerTick(*mountingManager_, eventTimestampMs);
}

void GpuiHost::on_frame(double eventTimestampMs) const {
  std::lock_guard<std::recursive_mutex> lock(animatedFrameMutex_);
  if (reactHost_->isReloading())
    return;
  dispatchPointerTick(*mountingManager_, eventTimestampMs);
#if LOOM_RENDERER
  // Animation props collected since the last frame reach the screen with it.
  loomHost_->animationFrameSource()->tick();
  GpuiLoomHost::runOnUIThread([] { LoomBinding::flushAnimationFrames(); });
#endif
  on_render();
  if (const auto& frame = rngpui::gpuiModuleHooks().frame) {
    const auto frameTimestampMs =
        std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now().time_since_epoch())
            .count();
    frame(frameTimestampMs);
  }
  {
    const auto frameTimestampMs =
        std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now().time_since_epoch())
            .count();
    for (const auto& frame : rngpui::gpuiExtensionHooks().frameCallbacks) {
      frame(frameTimestampMs);
    }
  }
  std::function<void()> animationFrame;
  {
    std::lock_guard<std::recursive_mutex> lock(animatedFrameMutex_);
    animationFrame = animatedFrameCallback_;
  }
  if (animationFrame) {
    if (gpuiDebugAnimationEnabled()) {
      static std::atomic<uint64_t> frames{0};
      const auto frame = ++frames;
      if (frame % 60 == 0) {
        LOG(INFO) << "[native-animated] GPUI delivered frame " << frame;
      }
    }
    animationFrame();
  }
}

void GpuiHost::dispatch_event(
    int32_t tag,
    rust::Str type,
    rust::Str payloadJson) const {
  mountingManager_->dispatchEvent(
      tag, std::string(type), folly::parseJson(std::string(payloadJson)));
}

void GpuiHost::dispatch_wheel(int32_t tag, uint64_t id, rust::Str payloadJson)
    const {
  mountingManager_->dispatchWheel(
      tag, id, folly::parseJson(std::string(payloadJson)));
}

void GpuiHost::dispatch_pointer_event(
    rust::Str targetChainJson,
    float x,
    float y,
    int32_t phase,
    double timestamp) const {
  extension::RawPointerEvent event;
  try {
    const auto targetChain = folly::parseJson(std::string(targetChainJson));
    if (!targetChain.isArray())
      return;
    event.targetChain.reserve(targetChain.size());
    for (const auto& tag : targetChain) {
      if (tag.isInt())
        event.targetChain.push_back(static_cast<int32_t>(tag.asInt()));
    }
  } catch (const std::exception& error) {
    LOG(WARNING) << "[pointer] invalid target chain: " << error.what();
    return;
  }
  event.x = x;
  event.y = y;
  event.phase = phase;
  event.timestamp = timestamp;
  {
    std::lock_guard<std::mutex> lock(pointerEventMutex);
    lastPointerEvent = event;
  }

  for (const auto& observer : gpuiExtensionHooks().pointerObservers) {
    for (const auto& recognized : observer(event)) {
      mountingManager_->dispatchEvent(
          recognized.targetTag,
          recognized.eventType,
          folly::parseJson(recognized.payloadJson));
    }
  }
}

void GpuiHost::set_scroll_offset(int32_t tag, float x, float y) const {
#if LOOM_RENDERER
  loomHost_->setScrollOffset(tag, x, y);
  return;
#endif
  mountingManager_->setScrollOffset(tag, x, y);
}
} // namespace rngpui

namespace rngpui {

std::shared_ptr<facebook::react::TurboModule> createTurboModule(
    const std::string& name,
    const std::shared_ptr<facebook::react::CallInvoker>& jsInvoker) {
  static const auto providers = gpui_turbo_module_providers();
  for (const auto& provider : providers) {
    if (auto module = provider(name, jsInvoker)) {
      return module;
    }
  }
  return nullptr;
}

} // namespace rngpui

namespace rngpui {

std::string currentColorScheme() {
  std::lock_guard<std::mutex> lock(appearanceMutex);
  return appearanceOverride.value_or(systemAppearance);
}

double windowScale() {
  return DeviceInfoModule::scale();
}

} // namespace rngpui
