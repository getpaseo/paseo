/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

#include "ReactInstanceConfig.h"

#include <utility>
#include <optional>
#include <mutex>
#include <ReactCommon/CallInvoker.h>
#include <ReactCommon/TurboModule.h>
#include <cxxreact/MessageQueueThread.h>
#include <react/logging/DefaultLogger.h>
#include <react/nativemodule/JavaScriptModule.h>
#include <react/nativemodule/TurboModuleProvider.h>
#include <react/renderer/animationbackend/AnimationChoreographer.h>
#include <react/renderer/scheduler/Scheduler.h>
#include <react/runtime/ReactInstance.h>
#include <react/utils/RunLoopObserverManager.h>
#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <optional>
#include <unordered_set>

namespace facebook::react {
class AnimatedMountingOverrideDelegate;
class DevServerHelper;
class IMountingManager;
class Inspector;
class NativeAnimatedNodesManagerProvider;
class PackagerConnection;
class SchedulerDelegate;
class SurfaceDelegate;
class SurfaceManager;
struct IDevUIDelegate;
struct ReactInstanceData;

class ReactHost {
 public:
  ReactHost(
      ReactInstanceConfig reactInstanceConfig,
      std::shared_ptr<IMountingManager> mountingManager,
      std::shared_ptr<RunLoopObserverManager> runLoopObserverManager,
      std::shared_ptr<const ContextContainer> contextContainer,
      JsErrorHandler::OnJsError onJsError,
      Logger logger,
      std::shared_ptr<IDevUIDelegate> devUIDelegate = nullptr,
      TurboModuleProviders turboModuleProviders = {},
      std::shared_ptr<SurfaceDelegate> logBoxSurfaceDelegate = nullptr,
      std::shared_ptr<NativeAnimatedNodesManagerProvider> animatedNodesManagerProvider = nullptr,
      ReactInstance::BindingsInstallFunc bindingsInstallFunc = nullptr,
      std::shared_ptr<AnimationChoreographer> animationChoreographer = nullptr);
  ReactHost(const ReactHost &) = delete;
  ReactHost &operator=(const ReactHost &) = delete;
  ReactHost(ReactHost &&) noexcept = delete;
  ReactHost &operator=(ReactHost &&) noexcept = delete;
  ~ReactHost() noexcept;

  bool loadScript(const std::string &bundlePath, const std::string &sourcePath) noexcept;

  void openDebugger();
  void requestReload() { reloadReactInstance(); }
  bool isReloading() const { return isReloadingReactInstance_.load(); }

  /// Monotonic count of the React instances this host has created, starting at
  /// 1 for the first. A reload destroys the old instance and creates a new one,
  /// so a test can tell "the tree is empty because the old instance is being
  /// torn down" from "the tree is empty because the new one has not mounted
  /// yet" by watching this change, instead of inferring it from an empty tree.
  uint64_t instanceGeneration() const {
    return instanceGeneration_.load(std::memory_order_relaxed);
  }

  void startSurface(
      SurfaceId surfaceId,
      const std::string &moduleName /* can be empty */,
      const folly::dynamic &initialProps,
      const LayoutConstraints &layoutConstraints,
      const LayoutContext &layoutContext = {}) noexcept;

  void setSurfaceConstraints(
      SurfaceId surfaceId,
      const LayoutConstraints &layoutConstraints,
      const LayoutContext &layoutContext) noexcept;

  void stopSurface(SurfaceId surfaceId) noexcept;

  void stopAllSurfaces() noexcept;

  bool isSurfaceRunning(SurfaceId surfaceId) const noexcept;

  std::unordered_set<SurfaceId> getRunningSurfaces() const noexcept;

  void runOnScheduler(std::function<void(Scheduler &scheduler)> &&task) const;

  std::optional<Size> surfaceContentSize(SurfaceId surfaceId) const;

  void runOnRuntimeScheduler(
      std::function<void(jsi::Runtime &runtime)> &&task,
      SchedulerPriority priority = SchedulerPriority::NormalPriority) const noexcept;

  void emitDeviceEvent(folly::dynamic &&args);

  // react-native-gpui: the Dev Menu's "Configure Bundler". Points the dev
  // server connections at `host:port` and reloads from there. Returns false
  // when this build has no dev server (dev mode off).
  bool setDevServer(const std::string &host, uint32_t port);
  // "host:port" of the dev server in use, or empty without one.
  std::string devServerAddress() const;

 private:
  void createReactInstance();
  void destroyReactInstance();
  void reloadReactInstance();

  bool loadScriptFromDevServer();
  bool loadScriptFromBundlePath(const std::string &bundlePath);

  std::string lastBundlePath_;
  std::string lastSourcePath_;
  const ReactInstanceConfig reactInstanceConfig_;
  std::unique_ptr<ReactInstanceData> reactInstanceData_;
  std::unique_ptr<ReactInstance> reactInstance_;
  std::atomic<bool> isReloadingReactInstance_{false};
  /// Incremented by `createReactInstance`, so it is 1 for the first instance and
  /// one more after each reload. See `instanceGeneration`.
  std::atomic<uint64_t> instanceGeneration_{0};

  std::unique_ptr<SchedulerDelegate> schedulerDelegate_;
  std::unique_ptr<Scheduler> scheduler_;
  std::unique_ptr<SurfaceManager> surfaceManager_;

  std::shared_ptr<DevServerHelper> devServerHelper_;
  std::shared_ptr<std::string> sourceURL_ = std::make_shared<std::string>();
  std::shared_ptr<Inspector> inspector_;
  std::unique_ptr<PackagerConnection> packagerConnection_;
  // Applied by the next reload, between the old instance and the new one.
  std::mutex pendingDevServerMutex_;
  std::optional<std::pair<std::string, uint32_t>> pendingDevServer_;

  std::shared_ptr<AnimatedMountingOverrideDelegate> animatedMountingOverrideDelegate_;
};
} // namespace facebook::react
