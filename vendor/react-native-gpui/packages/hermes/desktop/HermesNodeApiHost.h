// Node-API host integration for the Hermes engine used by react-native-gpui.
//
// Adapted from `react-native-node-api` (MIT), `cpp/HermesNapiHost.hpp` and
// `cpp/HermesNapiHost.cpp`:
//   https://github.com/callstack/react-native-node-api
// Copyright (c) Callstack, licensed under the MIT License.
//
// The name, namespace and logging were changed, the mirrored
// `hermes_napi_host` struct and the mirrored function declarations were
// dropped (the vendored Hermes API header is included directly now that
// weak-node-api's headers are gone), and everything React Native — other than
// the type-erased dispatcher this class is handed — was never here to begin
// with. The threading behaviour is unchanged.
#pragma once

// The vendored Hermes host-integration interface (`hermes_napi_host`,
// `hermes_napi_create_env`, `hermes_napi_load_module`). It pulls in the
// Node-API types as <hermes/napi/node_api.h>, which is how upstream Hermes
// ships them.
#include <napi/hermes_napi.h>

#include <functional>
#include <memory>

namespace rngpui {

/// Provides the `hermes_napi_host` integration for the Hermes Node-API
/// environments created by the host: a worker pool backing
/// napi_queue_async_work / napi_cancel_async_work and a JS-thread dispatcher
/// backing thread-safe functions.
///
/// One instance exists per React Native runtime. The JS-thread hop is
/// type-erased as `JsDispatcher` (backed by CallInvoker::invokeAsync in the
/// app) so this class has no React Native dependencies and its threading
/// machinery can be exercised by plain C++ tests.
class HostContext : public std::enable_shared_from_this<HostContext> {
 public:
  /// Dispatches a function onto the JS thread, returning whether it was
  /// accepted for delivery. Implementations must be safe to call from
  /// arbitrary threads, must never run the function inline and must deliver
  /// accepted functions one at a time, in order, on the single JS thread.
  /// Returning false (and dropping the function) is only acceptable once the
  /// JS runtime is gone — callers use the verdict to report outcomes
  /// truthfully, e.g. cancel_work only claims success while the cancelled
  /// completion can actually be delivered.
  using JsDispatcher = std::function<bool(std::function<void()>&&)>;

  static std::shared_ptr<HostContext> create(JsDispatcher dispatchToJs);

  /// Keep `context` alive for the remaining lifetime of the process. The
  /// Hermes env reads the host struct during Runtime teardown *after* running
  /// env cleanup hooks (napi_env__::shutdown() runs cleanup hooks first, then
  /// hermes_napi_cleanup_tsfns, which reaches host_->unref_loop through
  /// releaseTsfnLoopRef — verified at the pinned Hermes commit), so no
  /// cleanup hook can tell us when the last env is truly done with the
  /// struct. Retaining the context forever guarantees the documented
  /// contract that the struct outlives every env it was passed to, at the
  /// cost of a small allocation per React Native runtime (i.e. per reload).
  static void retainForProcessLifetime(std::shared_ptr<HostContext> context);

  /// The struct to pass to hermes_napi_create_env. Owned by this context.
  hermes_napi_host* host() {
    return &host_;
  }

  bool dispatchToJs(std::function<void()>&& fn) {
    return dispatchToJs_(std::move(fn));
  }

  // host_.data points at this object and the static callbacks cast it back,
  // so a copied or moved instance would service callbacks meant for another.
  HostContext(const HostContext&) = delete;
  HostContext& operator=(const HostContext&) = delete;

 private:
  explicit HostContext(JsDispatcher dispatchToJs);

  static void postWork(
      void* loop_data,
      void* work_data,
      void (*execute)(void* work_data),
      void (*complete)(void* work_data, napi_status status)) noexcept;
  static bool cancelWork(void* loop_data, void* work_data) noexcept;
  static void postTask(
      void* loop_data,
      void* task_data,
      void (*callback)(void* task_data)) noexcept;
  static void fatalException(void* data, napi_env env, napi_value err) noexcept;

  JsDispatcher dispatchToJs_;
  hermes_napi_host host_;
  // Reentrancy guard for fatalException(): true for the duration of routing
  // an error through ErrorUtils.reportFatalError. fatalException always runs
  // synchronously on the JS thread (see its doc comment), so a plain member
  // — no atomics or thread_local — is sufficient to detect a handler that
  // itself triggers napi_fatal_exception before the outer call returns.
  bool inFatalException_ = false;
};

} // namespace rngpui
