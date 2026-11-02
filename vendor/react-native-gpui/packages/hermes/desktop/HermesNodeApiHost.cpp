// Node-API host integration for the Hermes engine used by react-native-gpui.
//
// Adapted from `react-native-node-api` (MIT), `cpp/HermesNapiHost.hpp` and
// `cpp/HermesNapiHost.cpp`:
//   https://github.com/callstack/react-native-node-api
// Copyright (c) Callstack, licensed under the MIT License.
//
// The name, namespace and logging were changed and the header now includes the
// vendored Hermes API instead of mirroring it. The threading behaviour — the
// worker pool, cancellation, the dispatcher contract and fatal-exception
// routing — is unchanged.
#include "HermesNodeApiHost.h"

#include <condition_variable>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace rngpui {
namespace {

/// One line on stderr. This package renders Hermes diagnostics the same way on
/// every platform and has no logger of its own; nothing here is noisy enough to
/// need one.
void logWarning(const char* format, ...) {
  std::va_list args;
  va_start(args, format);
  std::fputs("NodeAddons: ", stderr);
  std::vfprintf(stderr, format, args);
  std::fputc('\n', stderr);
  va_end(args);
}

void logError(const char* format, ...) {
  std::va_list args;
  va_start(args, format);
  std::fputs("NodeAddons: ", stderr);
  std::vfprintf(stderr, format, args);
  std::fputc('\n', stderr);
  va_end(args);
}

struct WorkItem {
  // Identifies the HostContext that posted the item; matched together with
  // workData on cancellation. All envs of one runtime share one context, so
  // the pair only disambiguates across runtimes (i.e. reloads), where a freed
  // napi_async_work address could be reused by a new runtime's env.
  void* loopData = nullptr;
  // Held strongly: contexts are retained for the process lifetime anyway, and
  // whether the item's runtime can still receive its completion is reported
  // by the context's dispatcher, not by this pointer's liveness.
  std::shared_ptr<HostContext> context;
  void* workData = nullptr;
  void (*execute)(void* work_data) = nullptr;
  void (*complete)(void* work_data, napi_status status) = nullptr;
};

class WorkerPool {
 public:
  static WorkerPool& instance() {
    // Deliberately leaked, with detached threads, like libuv's process-global
    // thread pool: the pool must be able to outlive any single React Native
    // runtime and there is no shutdown point at which joining would be safe.
    static WorkerPool* pool = new WorkerPool();
    return *pool;
  }

  void enqueue(WorkItem&& item) {
    {
      std::lock_guard lock(mutex_);
      for (const WorkItem& queued : queue_) {
        if (queued.loopData == item.loopData &&
            queued.workData == item.workData) {
          // Queueing the same napi_async_work twice is undefined behavior in
          // Node (libuv asserts). Drop the duplicate instead of crashing:
          // enqueueing it would produce two completions for one work item,
          // and the second is a use-after-free once the addon has called
          // napi_delete_async_work from inside the first.
          logWarning(
              "dropping napi_async_work %p, queued while already queued",
              item.workData);
          return;
        }
      }
      queue_.push_back(std::move(item));
    }
    cv_.notify_one();
  }

  bool tryRemove(void* loopData, void* workData, WorkItem& result) {
    std::lock_guard lock(mutex_);
    for (auto it = queue_.begin(); it != queue_.end(); ++it) {
      if (it->loopData == loopData && it->workData == workData) {
        result = std::move(*it);
        queue_.erase(it);
        return true;
      }
    }
    return false;
  }

 private:
  // libuv's default thread pool size. Keep this below 5: the cancellation
  // tests make cancel-while-queued deterministic by saturating the pool with
  // 5 blocking jobs before queueing the item they cancel.
  static constexpr size_t kThreadCount = 4;

  WorkerPool() {
    for (size_t i = 0; i < kThreadCount; i++) {
      std::thread([this] { workerMain(); }).detach();
    }
  }

  void workerMain() {
    for (;;) {
      WorkItem item;
      {
        std::unique_lock lock(mutex_);
        cv_.wait(lock, [this] { return !queue_.empty(); });
        item = std::move(queue_.front());
        queue_.pop_front();
      }
      // An item is either popped here (execute runs, complete gets napi_ok)
      // or removed by tryRemove (complete gets napi_cancelled) — never both,
      // as both happen under the queue mutex.
      item.execute(item.workData);
      bool accepted = item.context->dispatchToJs(
          [workData = item.workData, complete = item.complete] {
            // No pool state refers to workData at this point, so the
            // complete callback is free to napi_delete_async_work it.
            complete(workData, napi_ok);
          });
      if (!accepted) {
        logWarning(
            "dropping an async work completion posted after runtime teardown");
      }
    }
  }

  std::mutex mutex_;
  std::condition_variable cv_;
  std::deque<WorkItem> queue_;
};

std::optional<std::string> stringValue(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) {
    return std::nullopt;
  }
  std::string result(length, '\0');
  if (napi_get_value_string_utf8(
          env, value, result.data(), length + 1, nullptr) != napi_ok) {
    return std::nullopt;
  }
  return result;
}

std::string describeError(napi_env env, napi_value err) {
  // Prefer the error's stack (which includes its message), fall back to
  // coercing the value to a string. Every call is status-checked: this runs
  // right before an abort and must not assume anything about the value.
  napi_value stack = nullptr;
  napi_valuetype type = napi_undefined;
  if (napi_get_named_property(env, err, "stack", &stack) == napi_ok &&
      napi_typeof(env, stack, &type) == napi_ok && type == napi_string) {
    if (auto text = stringValue(env, stack)) {
      return *text;
    }
  }
  napi_value coerced = nullptr;
  if (napi_coerce_to_string(env, err, &coerced) == napi_ok) {
    if (auto text = stringValue(env, coerced)) {
      return *text;
    }
  }
  return "(unable to stringify the error value)";
}

// Stringifies `err`, logs it and aborts — the pre-#402 behavior, kept as the
// fallback for whenever routing through ErrorUtils isn't possible.
[[noreturn]] void abortWithFatalException(napi_env env, napi_value err) {
  logError("napi_fatal_exception: %s", describeError(env, err).c_str());
  abort();
}

// Attempts to route `err` through React Native's
// `global.ErrorUtils.reportFatalError`, the moral equivalent of Node's
// process.emit('uncaughtException'): in dev this surfaces the real error and
// stack in LogBox, in release it feeds RN's default rethrow-to-native-crash
// handler, and apps can observe/handle it via ErrorUtils.setGlobalHandler.
// Returns whether the error was routed successfully. On any failure —
// ErrorUtils or reportFatalError absent/not the right type, or the call
// itself throwing — clears any pending exception before returning false, so
// the caller's fallback (which does its own Node-API calls) starts clean.
bool tryReportFatalError(napi_env env, napi_value err) {
  napi_value global = nullptr;
  if (napi_get_global(env, &global) != napi_ok) {
    return false;
  }

  napi_valuetype type = napi_undefined;
  napi_value error_utils = nullptr;
  if (napi_get_named_property(env, global, "ErrorUtils", &error_utils) !=
          napi_ok ||
      napi_typeof(env, error_utils, &type) != napi_ok || type != napi_object) {
    return false;
  }

  napi_value report_fatal_error = nullptr;
  if (napi_get_named_property(
          env, error_utils, "reportFatalError", &report_fatal_error) !=
          napi_ok ||
      napi_typeof(env, report_fatal_error, &type) != napi_ok ||
      type != napi_function) {
    return false;
  }

  napi_value argv[] = {err};
  napi_status call_status = napi_call_function(
      env, error_utils, report_fatal_error, 1, argv, nullptr);
  if (call_status != napi_ok) {
    // Most likely napi_pending_exception (the handler itself threw). Clear
    // it so the fallback path — which makes further Node-API calls — isn't
    // itself defeated by a stale pending exception.
    bool is_pending = false;
    if (napi_is_exception_pending(env, &is_pending) == napi_ok && is_pending) {
      napi_value discarded = nullptr;
      napi_get_and_clear_last_exception(env, &discarded);
    }
    return false;
  }

  return true;
}

} // namespace

HostContext::HostContext(JsDispatcher dispatchToJs)
    : dispatchToJs_(std::move(dispatchToJs)),
      host_{
          .post_work = &HostContext::postWork,
          // Hermes null-checks only the host pointer itself before invoking
          // post_work and cancel_work, so neither may individually be null.
          .cancel_work = &HostContext::cancelWork,
          .post_task = &HostContext::postTask,
          .data = this,
          // React Native has no libuv loop: napi_get_uv_event_loop() returns
          // napi_generic_failure, as upstream documents for non-Node hosts.
          .uv_loop = nullptr,
          .fatal_exception = &HostContext::fatalException,
          // The JS thread outlives every producer thread, so there is no loop
          // lifetime to model: tsfn ref/unref are tracked by Hermes but inert.
          .ref_loop = nullptr,
          .unref_loop = nullptr,
      } {}

std::shared_ptr<HostContext> HostContext::create(JsDispatcher dispatchToJs) {
  return std::shared_ptr<HostContext>(new HostContext(std::move(dispatchToJs)));
}

void HostContext::retainForProcessLifetime(
    std::shared_ptr<HostContext> context) {
  // Leaked for the same reason as the WorkerPool: no safe destruction point.
  static std::mutex* mutex = new std::mutex();
  static auto* retained = new std::vector<std::shared_ptr<HostContext>>();
  std::lock_guard lock(*mutex);
  retained->push_back(std::move(context));
}

void HostContext::postWork(
    void* loop_data,
    void* work_data,
    void (*execute)(void* work_data),
    void (*complete)(void* work_data, napi_status status)) noexcept {
  auto* self = static_cast<HostContext*>(loop_data);
  WorkerPool::instance().enqueue(WorkItem{
      .loopData = loop_data,
      .context = self->shared_from_this(),
      .workData = work_data,
      .execute = execute,
      .complete = complete,
  });
}

bool HostContext::cancelWork(void* loop_data, void* work_data) noexcept {
  WorkItem item;
  if (!WorkerPool::instance().tryRemove(loop_data, work_data, item)) {
    // Already picked up by a worker (or never queued): cancellation failed
    // and Hermes surfaces napi_generic_failure, like Node.
    return false;
  }
  // Deliver the cancelled completion asynchronously, matching Node, where a
  // cancelled complete callback still runs on a later loop tick. Success is
  // only reported while the dispatcher accepts the delivery: once the runtime
  // is torn down the complete callback can never run, and claiming success
  // would leave the addon waiting for a complete(napi_cancelled) that never
  // arrives.
  return item.context->dispatchToJs(
      [workData = item.workData, complete = item.complete] {
        complete(workData, napi_cancelled);
      });
}

void HostContext::postTask(
    void* loop_data,
    void* task_data,
    void (*callback)(void* task_data)) noexcept {
  auto* self = static_cast<HostContext*>(loop_data);
  // Thread-safe functions call this from arbitrary producer threads, and
  // Hermes' tsfnDispatch re-posts itself from inside the callback. The
  // dispatcher never runs the callback inline (JS would run off-thread) and
  // never drops it while the runtime is alive — a dropped dispatch would
  // permanently wedge the tsfn, as its dispatch_pending flag stays set. A
  // rejected dispatch therefore implies the runtime (and with it the tsfn's
  // env) is gone, making the wedged flag unobservable.
  if (!self->dispatchToJs_([task_data, callback] { callback(task_data); })) {
    logWarning(
        "dropping a thread-safe function dispatch posted after runtime "
        "teardown");
  }
}

void HostContext::fatalException(
    void* data,
    napi_env env,
    napi_value err) noexcept {
  // Called on the JS thread by napi_fatal_exception() — Hermes returns
  // napi_ok to the caller once this returns, matching Node, where emitting
  // 'uncaughtException' returns to the caller and only aborts the process if
  // no handler is installed (unlike napi_fatal_error, this hook has no
  // noreturn contract). `err` is only valid for the duration of this call.
  //
  // Routed through ErrorUtils.reportFatalError, RN's own
  // uncaughtException-equivalent: in dev the default handler shows LogBox
  // with the real error and stack, in release it rethrows into the native
  // crash path, and apps can observe/handle it via ErrorUtils.setGlobalHandler.
  // node-addon-api calls napi_fatal_exception whenever an exception escapes a
  // thread-safe function callback, so this is what stands between a throwing
  // tsfn callback and a silent, unhandled abort.
  auto* self = static_cast<HostContext*>(data);
  if (self->inFatalException_) {
    // Reentrant call: the ErrorUtils handler (or something it triggered)
    // itself hit a fatal exception. Recursing back into reportFatalError
    // could loop forever, so go straight to the fallback.
    abortWithFatalException(env, err);
  }
  self->inFatalException_ = true;
  bool routed = tryReportFatalError(env, err);
  self->inFatalException_ = false;
  if (!routed) {
    // ErrorUtils/reportFatalError absent (non-RN embedder, or called before
    // React Native has installed it) or the handler itself threw.
    abortWithFatalException(env, err);
  }
}

} // namespace rngpui
