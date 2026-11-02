#include "GpuiTurboModule.h"

#include <glog/logging.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#else
#include <pthread.h>
#endif

#include "rn-gpui-sys/src/lib.rs.h" // cxx bridge

namespace rngpui {
namespace {

/// Best-effort thread name: the platform truncates or rejects names it cannot
/// store, and a failure only costs a debugging aid.
void nameCurrentThread(const std::string& name) {
#if defined(_WIN32)
  using SetThreadDescriptionFn = HRESULT(WINAPI*)(HANDLE, PCWSTR);
  static const auto setThreadDescription = []() -> SetThreadDescriptionFn {
    const auto module = GetModuleHandleW(L"kernel32.dll");
    return module != nullptr
        ? reinterpret_cast<SetThreadDescriptionFn>(
              GetProcAddress(module, "SetThreadDescription"))
        : nullptr;
  }();
  if (setThreadDescription == nullptr) {
    return;
  }
  const auto size =
      MultiByteToWideChar(CP_UTF8, 0, name.c_str(), -1, nullptr, 0);
  if (size <= 1) {
    return;
  }
  std::wstring wide(static_cast<size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, name.c_str(), -1, wide.data(), size);
  setThreadDescription(GetCurrentThread(), wide.c_str());
#elif defined(__APPLE__)
  pthread_setname_np(name.c_str());
#else
  pthread_setname_np(pthread_self(), name.substr(0, 15).c_str());
#endif
}

std::mutex mainTasksMutex;
std::unordered_map<uint64_t, std::function<void()>> mainTasks;
std::atomic<uint64_t> nextMainTaskId{1};

} // namespace

struct ModuleQueue::State {
  std::mutex mutex;
  std::condition_variable ready;
  std::deque<std::function<void()>> tasks;
  bool started{false};
  bool stopped{false};
  std::thread worker;
};

ModuleQueue::ModuleQueue(std::string threadName)
    : state_(std::make_shared<State>()), threadName_(std::move(threadName)) {}

ModuleQueue::~ModuleQueue() {
  stop();
}

void ModuleQueue::stop() {
  if (!state_) {
    return;
  }
  auto state = std::move(state_);
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    state->stopped = true;
    state->tasks.clear();
  }
  state->ready.notify_all();
  if (!state->worker.joinable()) {
    return;
  }
  if (state->worker.get_id() == std::this_thread::get_id()) {
    // A task stops the queue of a module the JS thread released while the call
    // ran. The worker sees `stopped` and exits; joining would deadlock on
    // itself.
    state->worker.detach();
    return;
  }
  state->worker.join();
}

void ModuleQueue::post(std::function<void()> task) {
  bool startWorker = false;
  {
    std::lock_guard<std::mutex> lock(state_->mutex);
    if (state_->stopped) {
      return;
    }
    state_->tasks.push_back(std::move(task));
    if (!state_->started) {
      state_->started = true;
      startWorker = true;
    }
  }
  if (startWorker) {
    // The worker owns its state through the shared pointer, never through this.
    state_->worker = std::thread([state = state_, name = threadName_] {
      nameCurrentThread(name);
      for (;;) {
        std::function<void()> next;
        {
          std::unique_lock<std::mutex> lock(state->mutex);
          state->ready.wait(lock, [&state] {
            return state->stopped || !state->tasks.empty();
          });
          if (state->stopped) {
            return;
          }
          next = std::move(state->tasks.front());
          state->tasks.pop_front();
        }
        try {
          next();
        } catch (const std::exception& error) {
          LOG(ERROR) << "module queue task failed: " << error.what();
        }
      }
    });
  }
  state_->ready.notify_one();
}

void dispatchMain(std::function<void()> task) {
  const auto id = nextMainTaskId.fetch_add(1, std::memory_order_relaxed);
  {
    std::lock_guard<std::mutex> lock(mainTasksMutex);
    mainTasks.emplace(id, std::move(task));
  }
  rn_gpui_run_on_main(id);
}

void rn_gpui_run_main_task(uint64_t id) {
  std::function<void()> task;
  {
    std::lock_guard<std::mutex> lock(mainTasksMutex);
    auto entry = mainTasks.find(id);
    if (entry == mainTasks.end()) {
      return;
    }
    task = std::move(entry->second);
    mainTasks.erase(entry);
  }
  try {
    task();
  } catch (const std::exception& error) {
    LOG(ERROR) << "main thread task failed: " << error.what();
  }
}

} // namespace rngpui
