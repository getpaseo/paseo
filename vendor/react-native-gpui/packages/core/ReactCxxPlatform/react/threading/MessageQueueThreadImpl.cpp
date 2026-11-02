/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "MessageQueueThreadImpl.h"

#include <functional>
#include <atomic>
#include <memory>

namespace {
std::atomic<uint64_t> pendingJsTasks{0};
struct PendingTask {
  PendingTask() { ++pendingJsTasks; }
  ~PendingTask() { --pendingJsTasks; }
};
std::function<void()> tracked(std::function<void()> runnable) {
  auto activity = std::make_shared<PendingTask>();
  return [activity, runnable = std::move(runnable)]() { runnable(); };
}
}
extern "C" uint64_t rn_gpui_pending_js_tasks() noexcept {
  return pendingJsTasks.load();
}

namespace facebook::react {

void MessageQueueThreadImpl::runOnQueue(std::function<void()>&& runnable) {
  if (!taskDispatchThread_.isRunning()) {
    return;
  }
  taskDispatchThread_.runAsync(tracked(std::move(runnable)));
}

void MessageQueueThreadImpl::runOnQueueSync(std::function<void()>&& runnable) {
  if (!taskDispatchThread_.isRunning()) {
    return;
  }
  if (taskDispatchThread_.isOnThread()) {
    tracked(std::move(runnable))();
  } else {
    taskDispatchThread_.runSync(tracked(std::move(runnable)));
  }
}

void MessageQueueThreadImpl::quitSynchronous() {
  taskDispatchThread_.quit();
}

} // namespace facebook::react
