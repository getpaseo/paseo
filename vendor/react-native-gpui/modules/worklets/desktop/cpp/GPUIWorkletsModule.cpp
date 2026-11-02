#include "GPUIWorkletsModule.h"

#include "rn-gpui-sys/src/lib.rs.h"

#include <glog/logging.h>
#include <worklets/Tools/JSLogger.h>
#include <worklets/WorkletRuntime/RuntimeBindings.h>
#include <worklets/WorkletRuntime/WorkletRuntime.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <stdexcept>
#include <thread>
#include <utility>

#include "GpuiModules.h"

namespace {
bool animationTracingEnabled() {
  static const bool enabled = std::getenv("RN_GPUI_DEBUG_ANIMATION") != nullptr;
  return enabled;
}

std::mutex moduleMutex;
std::weak_ptr<gpui_worklets::Module> moduleInstance;
std::atomic<uint64_t> workletFrames{0};
std::atomic<uint64_t> workletRafRequests{0};

class GPUIScheduler final : public worklets::UIScheduler {
 protected:
  bool queryIsOnUIThread() const override {
    return gpui_worklets::isOnMainThread();
  }

 public:
  void scheduleOnUI(std::function<void()> job) override {
    static std::atomic<uint64_t> scheduled{0};
    const auto count = ++scheduled;
    if (animationTracingEnabled() && count <= 5) {
      LOG(INFO) << "[gpui-worklets] scheduleOnUI count=" << count
                << " onUI=" << isOnUIThread();
    }
    if (isOnUIThread()) {
      job();
      return;
    }
    UIScheduler::scheduleOnUI(std::move(job));
    rngpui::requestFrames("worklets", true);
  }
};

worklets::RuntimeBindings::NativeLoggingHook nativeLoggingHook() {
  return [](facebook::jsi::Runtime& runtime,
            const facebook::jsi::Value&,
            const facebook::jsi::Value* args,
            size_t count) -> facebook::jsi::Value {
    if (count != 2) {
      throw std::invalid_argument("nativeLoggingHook takes 2 arguments");
    }
    const auto message = args[0].asString(runtime).utf8(runtime);
    LOG(INFO) << "[worklet] " << message;
    return facebook::jsi::Value::undefined();
  };
}
} // namespace

namespace gpui_worklets {
namespace {
std::mutex uiThreadMutex;
std::thread::id uiThreadId;
} // namespace

bool isOnMainThread() {
  // The runtime records the main thread before its loop runs. `onFrame` only
  // notes it once a frame arrives, and `UIScheduler::isOnUIThread` caches the
  // first answer per thread: a query that comes first, such as a layout
  // animation flush, would pin "not the UI thread" on the main thread for good.
  if (rngpui::rn_gpui_is_main_thread()) {
    return true;
  }
  std::lock_guard<std::mutex> lock(uiThreadMutex);
  return uiThreadId != std::thread::id{} &&
      uiThreadId == std::this_thread::get_id();
}

void noteMainThread() {
  std::lock_guard<std::mutex> lock(uiThreadMutex);
  if (uiThreadId == std::thread::id{}) {
    uiThreadId = std::this_thread::get_id();
  }
}

Module::Module(std::shared_ptr<facebook::react::CallInvoker> jsInvoker)
    : NativeWorkletsModuleSpec(std::move(jsInvoker)) {}

Module::~Module() {
  rngpui::reportPendingWork("worklets", 0);
  rngpui::requestFrames("worklets", false);
  if (initializer_) {
    initializer_->invalidate();
  }
  std::lock_guard<std::mutex> lock(moduleMutex);
  if (moduleInstance.lock().get() == this) {
    moduleInstance.reset();
  }
}

void Module::initialize(facebook::jsi::Runtime& runtime) {
  if (initializer_)
    return;
  uiScheduler_ = std::make_shared<GPUIScheduler>();
  runtimeStatus_ = std::make_shared<worklets::RNRuntimeStatus>();
  jsScheduler_ = std::make_shared<worklets::JSScheduler>(
      runtime, jsInvoker_, [] { return true; });
  std::weak_ptr<Module> weakModule = shared_from_this();
  auto runtimeBindings =
      std::make_shared<worklets::RuntimeBindings>(worklets::RuntimeBindings{
          .requestAnimationFrame =
              [weakModule](std::function<void(double)> callback) {
                if (auto module = weakModule.lock()) {
                  module->requestAnimationFrame(std::move(callback));
                }
              },
          .nativeLoggingHook = nativeLoggingHook(),
          .networkingBackend = nullptr,
      });
  initializer_ = std::make_shared<worklets::WorkletsModuleProxyInitializer>(
      jsScheduler_, uiScheduler_, runtimeBindings, runtimeStatus_);
  LOG(INFO) << "[gpui-worklets] initialized runtime bindings";
  auto initializer = initializer_;
  std::thread([initializer] { initializer->prepareProxy(); }).detach();
}

bool Module::installTurboModule(
    facebook::jsi::Runtime& runtime,
    bool bundleModeEnabled) {
  initialize(runtime);
  if (bundleModeEnabled) {
    throw facebook::jsi::JSError(
        runtime, "GPUI Worklets does not support Bundle Mode yet");
  }
  proxy_ = initializer_->finalize(runtime, false, {});
  LOG(INFO) << "[gpui-worklets] WorkletsModule installed";
  return true;
}

bool Module::prepareBundleMode(facebook::jsi::Runtime& runtime) {
  throw facebook::jsi::JSError(
      runtime, "GPUI Worklets does not support Bundle Mode yet");
}

bool Module::start(facebook::jsi::Runtime& runtime) {
  if (!proxy_)
    throw facebook::jsi::JSError(
        runtime, "WorkletsModule.installTurboModule must run before start");
  proxy_->start();
  LOG(INFO) << "[gpui-worklets] UI runtime started";
  return true;
}

bool Module::toggleSlowAnimationsOnUIRuntime(facebook::jsi::Runtime&) {
  return false;
}

void Module::requestAnimationFrame(std::function<void(double)> callback) {
  const auto count = ++workletRafRequests;
  if (animationTracingEnabled() && count <= 5) {
    LOG(INFO) << "[gpui-worklets] requestAnimationFrame count=" << count;
  }
  {
    std::lock_guard<std::mutex> lock(callbacksMutex_);
    frameCallbacks_.push_back(std::move(callback));
  }
  rngpui::requestFrames("worklets", true);
}

void Module::onFrame(double timestampMs) {
  const auto count = ++workletFrames;
  if (animationTracingEnabled()) {
    static double windowStartMs = timestampMs;
    static double previousFrameMs = timestampMs;
    static double maximumGapMs = 0;
    maximumGapMs = std::max(maximumGapMs, timestampMs - previousFrameMs);
    previousFrameMs = timestampMs;
    if (count % 60 == 0) {
      LOG(INFO) << "[gpui-worklets] native frame cadence frames=60 elapsed_ms="
                << timestampMs - windowStartMs
                << " max_frame_gap_ms=" << maximumGapMs;
      windowStartMs = timestampMs;
      maximumGapMs = 0;
    }
  }
  if (animationTracingEnabled() && (count <= 5 || count % 600 == 0)) {
    LOG(INFO) << "[gpui-worklets] GPUI frame count=" << count;
  }
  // Frame callbacks are platform entry points, outside Worklets' guarded
  // invocation paths. Report JS exceptions on RN rather than unwinding across
  // the CXX boundary and terminating the desktop process.
  const auto reportError = [this](const facebook::jsi::JSError& error) {
    LOG(ERROR) << "[gpui-worklets] " << error.what();
    worklets::JSLogger::reportFatalErrorOnJS(
        jsScheduler_,
        {.message = error.getMessage(),
         .stack = error.getStack(),
         .name = "WorkletsError"});
  };
  try {
    if (uiScheduler_)
      uiScheduler_->triggerUI();
  } catch (const facebook::jsi::JSError& error) {
    reportError(error);
  }
  // Worklets has a perpetual native heartbeat even when its JS RAF queue is
  // empty. Test synchronization observes application callbacks, not that beat.
  if (std::getenv("RN_GPUI_TEST_DRIVER")) {
    if (auto runtime = uiRuntime()) {
      runtime->runSync([](facebook::jsi::Runtime& rt) {
        auto global = rt.global();
        if (!global.hasProperty(rt, "requestAnimationFrame") ||
            (global.hasProperty(rt, "__gpuiTestRaf") &&
             facebook::jsi::Value::strictEquals(
                 rt,
                 global.getProperty(rt, "requestAnimationFrame"),
                 global.getProperty(rt, "__gpuiTestRaf"))))
          return;
        global.setProperty(
            rt,
            "__gpuiReportPendingRaf",
            facebook::jsi::Function::createFromHostFunction(
                rt,
                facebook::jsi::PropNameID::forAscii(
                    rt, "__gpuiReportPendingRaf"),
                1,
                [](facebook::jsi::Runtime&,
                   const facebook::jsi::Value&,
                   const facebook::jsi::Value* args,
                   size_t count) {
                  if (count == 1 && args[0].isNumber())
                    rngpui::reportPendingWork(
                        "worklets", static_cast<uint64_t>(args[0].getNumber()));
                  return facebook::jsi::Value::undefined();
                }));
        rt.evaluateJavaScript(
            std::make_shared<facebook::jsi::StringBuffer>(R"JS(
          (() => {
            const raf = globalThis.requestAnimationFrame;
            const cancel = globalThis.cancelAnimationFrame;
            const pending = new Set();
            const report = () => globalThis.__gpuiReportPendingRaf(pending.size);
            globalThis.requestAnimationFrame = callback => {
              let id;
              id = raf(timestamp => {
                pending.delete(id); report(); callback(timestamp);
              });
              pending.add(id); report(); return id;
            };
            globalThis.cancelAnimationFrame = id => {
              pending.delete(id); report(); cancel(id);
            };
            globalThis.__gpuiTestRaf = globalThis.requestAnimationFrame;
            report();
          })();
        )JS"),
            "gpui-test-raf.js");
      });
    }
  }
  std::vector<std::function<void(double)>> callbacks;
  {
    std::lock_guard<std::mutex> lock(callbacksMutex_);
    callbacks.swap(frameCallbacks_);
  }
  if (animationTracingEnabled() && !callbacks.empty() &&
      (count <= 5 || count % 60 == 0)) {
    LOG(INFO) << "[gpui-worklets] callbacks on frame=" << callbacks.size();
  }
  for (auto& callback : callbacks) {
    try {
      callback(timestampMs);
    } catch (const facebook::jsi::JSError& error) {
      reportError(error);
    }
  }
  {
    std::lock_guard<std::mutex> lock(callbacksMutex_);
    if (frameCallbacks_.empty()) {
      rngpui::requestFrames("worklets", false);
    }
  }
}

std::shared_ptr<worklets::WorkletRuntime> Module::uiRuntime() const {
  return proxy_ ? proxy_->getUIWorkletRuntime() : nullptr;
}

std::shared_ptr<worklets::UIScheduler> Module::uiScheduler() const {
  return uiScheduler_;
}

void onFrame(double timestampMs) {
  noteMainThread();
  std::shared_ptr<Module> module;
  {
    std::lock_guard<std::mutex> lock(moduleMutex);
    module = moduleInstance.lock();
  }
  if (module)
    module->onFrame(timestampMs);
}

std::shared_ptr<Module> currentModule() {
  std::lock_guard<std::mutex> lock(moduleMutex);
  return moduleInstance.lock();
}

std::shared_ptr<facebook::react::TurboModule> createModule(
    const std::string& name,
    std::shared_ptr<facebook::react::CallInvoker> jsInvoker) {
  if (name != Module::kModuleName)
    return nullptr;
  auto module = std::make_shared<Module>(std::move(jsInvoker));
  {
    std::lock_guard<std::mutex> lock(moduleMutex);
    moduleInstance = module;
  }
  return module;
}
} // namespace gpui_worklets

std::shared_ptr<facebook::react::TurboModule> create_gpui_worklets_module(
    const std::string& name,
    std::shared_ptr<facebook::react::CallInvoker> jsInvoker) {
  return gpui_worklets::createModule(name, std::move(jsInvoker));
}
