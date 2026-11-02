#include "GPUIWorkletsModule.h"
#include "GpuiHost.h"

#include <GPUIReanimatedSpec.h>
#include <reanimated/NativeModules/ReanimatedModuleProxy.h>
#include <reanimated/RuntimeDecorators/RNRuntimeDecorator.h>
#include <reanimated/Tools/PlatformDepMethodsHolder.h>
#include <worklets/Compat/StableApi.h>

#include <glog/logging.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <memory>
#include <utility>

namespace {
bool animationTracingEnabled() {
  static const bool enabled = std::getenv("RN_GPUI_DEBUG_ANIMATION") != nullptr;
  return enabled;
}

using facebook::jsi::Runtime;
using reanimated::PlatformDepMethodsHolder;
using reanimated::ReanimatedModuleProxy;

PlatformDepMethodsHolder platformMethods(
    const std::shared_ptr<std::weak_ptr<ReanimatedModuleProxy>>& proxyHolder) {
  PlatformDepMethodsHolder methods;
  methods.requestRender = [](std::function<void(const double)> callback) {
    static std::atomic<uint64_t> requests{0};
    const auto count = ++requests;
    if (animationTracingEnabled() && (count <= 5 || count % 60 == 0)) {
      LOG(INFO) << "[gpui-reanimated] requestRender count=" << count;
    }
    auto module = gpui_worklets::currentModule();
    if (module)
      module->requestAnimationFrame(std::move(callback));
  };
  methods.synchronouslyUpdateUIPropsFunction = [](const int tag,
                                                  const folly::dynamic& props) {
    rngpui::gpui_synchronously_update_props(tag, props);
  };
  methods.getAnimationTimestamp = [] {
    return std::chrono::duration<double, std::milli>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
  };
  methods.registerSensor =
      [](int, int, int, std::function<void(double[], int)>) { return 0; };
  methods.unregisterSensor = [](int) {};
  methods.setGestureStateFunction = [](int, int) {};
  methods.maybeFlushUIUpdatesQueueFunction = [proxyHolder] {
    if (auto proxy = proxyHolder->lock()) {
      proxy->performOperations();
    }
  };
  methods.attachPseudoSelector = [](facebook::react::Tag,
                                    reanimated::PseudoSelector,
                                    std::function<void(bool)> callback) {
    if (callback)
      callback(false);
  };
  methods.detachPseudoSelector = [](facebook::react::Tag,
                                    reanimated::PseudoSelector) {};
#if defined(__APPLE__)
  methods.forceScreenSnapshotFunction = [](facebook::react::Tag) {
    return false;
  };
  methods.readMountedViewPropsFunction =
      [](facebook::react::Tag) -> facebook::react::Props::Shared {
    return nullptr;
  };
#endif
  return methods;
}

class Module final
    : public facebook::react::NativeReanimatedModuleSpec<Module> {
 public:
  explicit Module(std::shared_ptr<facebook::react::CallInvoker> jsInvoker)
      : NativeReanimatedModuleSpec(std::move(jsInvoker)) {}

  bool installTurboModule(Runtime& runtime) {
    if (proxy_)
      return true;
    auto worklets = gpui_worklets::currentModule();
    auto uiManager = rngpui::get_gpui_ui_manager();
    if (!worklets || !worklets->uiRuntime() || !worklets->uiScheduler() ||
        !uiManager) {
      throw facebook::jsi::JSError(
          runtime, "GPUI Reanimated requires initialized Worklets and Fabric");
    }

    // The platform flush callback is constructed before the proxy exists.
    // Retain only a weak reference so the decorated UI runtime cannot keep
    // the module alive after React Native tears it down.
    auto proxyHolder = std::make_shared<std::weak_ptr<ReanimatedModuleProxy>>();
    auto methods = platformMethods(proxyHolder);
    proxy_ = std::make_shared<ReanimatedModuleProxy>(
        worklets->uiRuntime(),
        worklets->uiScheduler(),
        runtime,
        jsInvoker_,
        methods,
        false);
    *proxyHolder = proxy_;
    proxy_->init(methods);
    proxy_->initializeFabric(uiManager);
    LOG(INFO) << "[gpui-reanimated] module proxy initialized";
    auto& uiRuntime =
        worklets::getJSIRuntimeFromWorkletRuntime(worklets->uiRuntime());
    reanimated::RNRuntimeDecorator::decorate(runtime, uiRuntime, proxy_);
    std::weak_ptr<ReanimatedModuleProxy> weakProxy = proxy_;
    eventListener_ = std::make_shared<const facebook::react::EventListener>(
        [weakProxy](const facebook::react::RawEvent& event) {
          auto proxy = weakProxy.lock();
          if (!proxy)
            return false;
          const auto timestamp =
              std::chrono::duration<double, std::milli>(
                  std::chrono::steady_clock::now().time_since_epoch())
                  .count();
          static std::atomic<uint64_t> events{0};
          const auto count = ++events;
          if (animationTracingEnabled() &&
              event.type.find("GestureHandler") != std::string::npos) {
            const auto* target = event.eventTarget.get();
            const auto tag = target ? target->getTag() : -1;
            auto eventName = event.type;
            if (eventName.rfind("top", 0) == 0) {
              eventName = "on" + eventName.substr(3);
            }
            LOG(INFO) << "[gpui-reanimated] gesture lookup type=" << eventName
                      << " tag=" << tag << " waiting="
                      << proxy->isAnyHandlerWaitingForEvent(eventName, tag);
          }
          if (animationTracingEnabled() &&
              (count <= 10 ||
               event.type.find("GestureHandler") != std::string::npos)) {
            LOG(INFO) << "[gpui-reanimated] raw event count=" << count
                      << " type=" << event.type;
          }
          return proxy->handleRawEvent(event, timestamp);
        });
    rngpui::register_gpui_event_listener(eventListener_);
    return true;
  }

  std::shared_ptr<ReanimatedModuleProxy> proxy_;
  std::shared_ptr<const facebook::react::EventListener> eventListener_;
};
} // namespace

std::shared_ptr<facebook::react::TurboModule> create_gpui_reanimated_module(
    const std::string& name,
    std::shared_ptr<facebook::react::CallInvoker> jsInvoker) {
  return rngpui::provideTurboModule<Module>(name, std::move(jsInvoker));
}
