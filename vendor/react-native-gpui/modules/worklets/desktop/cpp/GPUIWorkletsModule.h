#pragma once

#include <GPUIWorkletsSpec.h>
#include <ReactCommon/CallInvoker.h>
#include <ReactCommon/TurboModule.h>
#include <worklets/NativeModules/WorkletsModuleProxy.h>
#include <worklets/NativeModules/WorkletsModuleProxyInitializer.h>
#include <worklets/Tools/JSScheduler.h>
#include <worklets/Tools/RNRuntimeStatus.h>
#include <worklets/Tools/UIScheduler.h>

#include <functional>
#include <memory>
#include <mutex>
#include <vector>

namespace gpui_worklets {
bool isOnMainThread();
void noteMainThread();

class Module final : public facebook::react::NativeWorkletsModuleSpec<Module> {
 public:
  explicit Module(std::shared_ptr<facebook::react::CallInvoker> jsInvoker);
  ~Module() override;

  void onFrame(double timestampMs);
  void requestAnimationFrame(std::function<void(double)> callback);
  std::shared_ptr<worklets::WorkletRuntime> uiRuntime() const;
  std::shared_ptr<worklets::UIScheduler> uiScheduler() const;

  bool installTurboModule(
      facebook::jsi::Runtime& runtime,
      bool bundleModeEnabled);
  bool prepareBundleMode(facebook::jsi::Runtime& runtime);
  bool start(facebook::jsi::Runtime& runtime);
  bool toggleSlowAnimationsOnUIRuntime(facebook::jsi::Runtime& runtime);

 private:
  void initialize(facebook::jsi::Runtime& runtime);

  std::shared_ptr<worklets::UIScheduler> uiScheduler_;
  std::shared_ptr<worklets::JSScheduler> jsScheduler_;
  std::shared_ptr<worklets::RNRuntimeStatus> runtimeStatus_;
  std::shared_ptr<worklets::WorkletsModuleProxyInitializer> initializer_;
  std::shared_ptr<worklets::WorkletsModuleProxy> proxy_;
  std::mutex callbacksMutex_;
  std::vector<std::function<void(double)>> frameCallbacks_;
};

void onFrame(double timestampMs);
std::shared_ptr<Module> currentModule();
std::shared_ptr<facebook::react::TurboModule> createModule(
    const std::string& name,
    std::shared_ptr<facebook::react::CallInvoker> jsInvoker);

} // namespace gpui_worklets

std::shared_ptr<facebook::react::TurboModule> create_gpui_worklets_module(
    const std::string& name,
    std::shared_ptr<facebook::react::CallInvoker> jsInvoker);
