/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "MessageQueueThreadImpl.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>
#if defined(__APPLE__) || defined(__linux__)
#include <execinfo.h>
#endif

namespace {
std::atomic<uint64_t> pendingJsTasks{0};

// With RN_GPUI_DEBUG_JS_TASKS set, every queued task remembers where it was
// queued from, so a task that never finishes can be named.
struct TaskRecord {
  std::chrono::steady_clock::time_point queuedAt;
  std::chrono::steady_clock::time_point startedAt;
  bool started{false};
  std::vector<std::string> frames;
};

bool debugTasks() {
  static const bool enabled = std::getenv("RN_GPUI_DEBUG_JS_TASKS") != nullptr;
  return enabled;
}

std::mutex& recordsMutex() {
  static std::mutex mutex;
  return mutex;
}

std::map<uint64_t, TaskRecord>& records() {
  static std::map<uint64_t, TaskRecord> map;
  return map;
}

std::atomic<uint64_t> nextTaskId{1};

std::vector<std::string> callSite() {
  std::vector<std::string> frames;
#if defined(__APPLE__) || defined(__linux__)
  void* stack[24];
  const int count = backtrace(stack, 24);
  char** symbols = backtrace_symbols(stack, count);
  if (symbols != nullptr) {
    // Skip this function, `tracked` and the queue call itself.
    for (int i = 3; i < count; ++i) {
      frames.emplace_back(symbols[i]);
    }
    free(symbols);
  }
#endif
  return frames;
}

struct PendingTask {
  uint64_t id{0};
  PendingTask() {
    ++pendingJsTasks;
    if (debugTasks()) {
      id = nextTaskId++;
      TaskRecord record;
      record.queuedAt = std::chrono::steady_clock::now();
      record.frames = callSite();
      std::lock_guard<std::mutex> lock(recordsMutex());
      records()[id] = std::move(record);
    }
  }
  ~PendingTask() {
    --pendingJsTasks;
    if (id != 0) {
      std::lock_guard<std::mutex> lock(recordsMutex());
      records().erase(id);
    }
  }
  void markStarted() const {
    if (id != 0) {
      std::lock_guard<std::mutex> lock(recordsMutex());
      auto it = records().find(id);
      if (it != records().end()) {
        it->second.started = true;
        it->second.startedAt = std::chrono::steady_clock::now();
      }
    }
  }
};

std::function<void()> tracked(std::function<void()> runnable) {
  auto activity = std::make_shared<PendingTask>();
  return [activity, runnable = std::move(runnable)]() {
    activity->markStarted();
    runnable();
  };
}
}

// The outstanding JS tasks, oldest first, as text; empty unless
// RN_GPUI_DEBUG_JS_TASKS is set. Copies at most `capacity` bytes into `buffer`
// and returns the length of the whole text.
extern "C" uint64_t rn_gpui_pending_js_tasks_dump(
    char* buffer,
    uint64_t capacity) noexcept {
  std::string text;
  {
    std::lock_guard<std::mutex> lock(recordsMutex());
    const auto now = std::chrono::steady_clock::now();
    for (const auto& [id, record] : records()) {
      const auto since = record.started ? record.startedAt : record.queuedAt;
      const auto ms =
          std::chrono::duration_cast<std::chrono::milliseconds>(now - since)
              .count();
      text += "task " + std::to_string(id) +
          (record.started ? " running for " : " queued for ") +
          std::to_string(ms) + " ms, queued from:\n";
      for (const auto& frame : record.frames) {
        text += "    " + frame + "\n";
      }
    }
  }
  if (buffer != nullptr && capacity > 0) {
    const auto copied = std::min<uint64_t>(capacity, text.size());
    std::memcpy(buffer, text.data(), copied);
  }
  return text.size();
}

extern "C" uint64_t rn_gpui_pending_js_tasks() noexcept {
  return pendingJsTasks.load();
}

namespace facebook::react {

std::function<void()> trackJsTask(std::function<void()> runnable) {
  return tracked(std::move(runnable));
}

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
