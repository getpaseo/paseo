#include "GpuiModules.h"

#include <mutex>

namespace rngpui {
namespace {
std::mutex frameRequestsMutex;
std::mutex pendingWorkMutex;
std::unordered_map<std::string, uint64_t>& pendingWorkByOwner() {
  static std::unordered_map<std::string, uint64_t> work;
  return work;
}
} // namespace

GpuiModuleHooks& gpuiModuleHooks() {
  static GpuiModuleHooks hooks;
  return hooks;
}

GpuiExtensionHooks& gpuiExtensionHooks() {
  static GpuiExtensionHooks hooks;
  return hooks;
}

void registerComponentProps(
    const std::string& componentName,
    extension::ComponentPropsFn fn) {
  gpuiExtensionHooks().componentProps[componentName] = std::move(fn);
}

void registerMountObserver(extension::MountObserver observer) {
  gpuiExtensionHooks().mountObservers.push_back(std::move(observer));
}

void registerWindowInsetsObserver(extension::WindowInsetsFn fn) {
  gpuiExtensionHooks().windowInsetsObservers.push_back(std::move(fn));
}

void registerFrameCallback(GpuiFrameFn fn) {
  gpuiExtensionHooks().frameCallbacks.push_back(std::move(fn));
}

void requestFrames(const std::string& owner, bool needsFrames) {
  {
    std::lock_guard<std::mutex> lock(frameRequestsMutex);
    gpuiExtensionHooks().frameRequests[owner] = needsFrames;
  }
  updateFrameDemand();
}

bool anyFrameRequested() {
  std::lock_guard<std::mutex> lock(frameRequestsMutex);
  for (const auto& [owner, needsFrames] : gpuiExtensionHooks().frameRequests) {
    if (needsFrames)
      return true;
  }
  return false;
}

void reportPendingWork(const std::string& owner, uint64_t count) {
  std::lock_guard<std::mutex> lock(pendingWorkMutex);
  if (count == 0)
    pendingWorkByOwner().erase(owner);
  else
    pendingWorkByOwner()[owner] = count;
}

uint64_t pendingWork() {
  std::lock_guard<std::mutex> lock(pendingWorkMutex);
  uint64_t total = 0;
  for (const auto& [owner, count] : pendingWorkByOwner())
    total += count;
  return total;
}

void registerPointerObserver(extension::PointerObserverFn fn) {
  gpuiExtensionHooks().pointerObservers.push_back(std::move(fn));
}

} // namespace rngpui
