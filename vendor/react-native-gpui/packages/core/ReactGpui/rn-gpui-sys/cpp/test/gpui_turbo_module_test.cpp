// Unit test for the module task queue: ordering, that work leaves the caller's
// thread, and that destruction never hangs.
#include "GpuiTurboModule.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

/// Stands in for the Rust side of `rngpui::dispatchMain`, which this test does
/// not link.
namespace rngpui {
void rn_gpui_run_on_main(uint64_t) noexcept {}
} // namespace rngpui

namespace {

int failures = 0;

void check(bool condition, const std::string& what) {
  if (!condition) {
    ++failures;
    std::fprintf(stderr, "FAIL: %s\n", what.c_str());
  }
}

void checkRunsInOrderOnOneThread() {
  rngpui::ModuleQueue queue("rn.module.Test");
  const auto caller = std::this_thread::get_id();
  std::mutex mutex;
  std::condition_variable done;
  std::vector<int> order;
  std::vector<std::thread::id> threads;
  for (int index = 0; index < 8; ++index) {
    queue.post([&, index] {
      std::lock_guard<std::mutex> lock(mutex);
      order.push_back(index);
      threads.push_back(std::this_thread::get_id());
      if (order.size() == 8) {
        done.notify_one();
      }
    });
  }
  {
    std::unique_lock<std::mutex> lock(mutex);
    done.wait_for(
        lock, std::chrono::seconds(10), [&] { return order.size() == 8; });
  }
  check(order.size() == 8, "every posted task ran");
  for (size_t index = 0; index < order.size(); ++index) {
    check(
        order[index] == static_cast<int>(index),
        "tasks run in the order they were posted");
  }
  check(
      !threads.empty() && threads.front() != caller,
      "the worker is not the posting thread");
  for (const auto thread : threads) {
    check(thread == threads.front(), "all tasks run on one worker thread");
  }
}

void checkDestructionDiscardsPendingTasks() {
  std::atomic<int> finished{0};
  {
    rngpui::ModuleQueue queue("rn.module.Test");
    queue.post([&] {
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
      finished.fetch_add(1);
    });
    for (int index = 0; index < 32; ++index) {
      queue.post([&] { finished.fetch_add(1); });
    }
  }
  check(
      finished.load() <= 1,
      "tasks still pending when the queue is destroyed are discarded");
}

void checkDestructionFromWorkerDoesNotDeadlock() {
  // The task deletes the queue, so the destructor runs on the worker thread.
  auto* queue = new rngpui::ModuleQueue("rn.module.Test");
  std::mutex mutex;
  std::condition_variable destroyed;
  bool destroyedFlag = false;
  queue->post([queue, &mutex, &destroyed, &destroyedFlag] {
    delete queue;
    {
      std::lock_guard<std::mutex> lock(mutex);
      destroyedFlag = true;
    }
    destroyed.notify_one();
  });
  std::unique_lock<std::mutex> lock(mutex);
  const auto destroyedInTime = destroyed.wait_for(
      lock, std::chrono::seconds(10), [&] { return destroyedFlag; });
  check(destroyedInTime, "destroying the queue from its worker does not hang");
}

} // namespace

int main() {
  checkRunsInOrderOnOneThread();
  checkDestructionDiscardsPendingTasks();
  checkDestructionFromWorkerDoesNotDeadlock();
  if (failures != 0) {
    std::fprintf(stderr, "%d check(s) failed\n", failures);
    return 1;
  }
  std::printf("gpui_turbo_module_test: all checks passed\n");
  return 0;
}
