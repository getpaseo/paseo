/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#ifndef HERMES_NAPI_HERMES_NAPI_H
#define HERMES_NAPI_HERMES_NAPI_H

#include "hermes/napi/node_api.h"

//===========================================================================
// Host integration interface
//===========================================================================

/// Abstract interface that the host application can provide to integrate
/// with its runtime environment. This covers async work scheduling
/// (napi_create_async_work / napi_queue_async_work), thread-safe
/// function dispatch, libuv event loop access, and fatal exception
/// handling. Fields left as nullptr preserve default behavior — in
/// particular, async work and thread-safe function APIs will return
/// napi_generic_failure if the relevant callbacks are not provided.
///
/// The host is responsible for the lifetime of this struct — it must
/// outlive the napi_env that references it.
struct hermes_napi_host {
  /// Schedule \p execute to run on a worker thread. When execute
  /// completes, schedule \p complete to run on the main (JS) thread.
  /// \p data is passed through to both callbacks.
  /// \p complete receives \p status == 0 on success, or
  /// napi_cancelled if the work was cancelled.
  void (*post_work)(
      void *loop_data,
      void *work_data,
      void (*execute)(void *work_data),
      void (*complete)(void *work_data, napi_status status));

  /// Cancel a previously posted work item. The event loop should
  /// attempt to cancel the work. If successful, the complete callback
  /// from post_work should be called with status == napi_cancelled.
  /// Returns true if cancellation was initiated, false if the work
  /// has already started or completed.
  bool (*cancel_work)(void *loop_data, void *work_data);

  /// Schedule \p callback to run on the main (JS) thread.
  /// This is used by thread-safe functions to dispatch queued calls.
  /// \p data is passed through to the callback.
  void (*post_task)(
      void *loop_data,
      void *task_data,
      void (*callback)(void *task_data));

  /// Opaque data pointer passed as the first argument to post_work,
  /// cancel_work, and post_task. Typically the host's event loop
  /// instance.
  void *data;

  /// If non-null, napi_get_uv_event_loop() returns this pointer.
  /// The host is responsible for the lifetime — it must outlive the
  /// napi_env. Embedders without libuv leave this nullptr (the
  /// default), in which case napi_get_uv_event_loop() returns
  /// napi_generic_failure.
  struct uv_loop_s *uv_loop;

  /// If non-null, called by napi_fatal_exception() instead of aborting.
  /// The host typically routes this to
  /// process.emit('uncaughtException', err).
  /// Receives the host data pointer, the napi_env, and the error value.
  /// When null (the default), napi_fatal_exception() prints the error
  /// and calls abort() via hermes_fatal().
  void (*fatal_exception)(void *data, napi_env env, napi_value err);

  /// Hold a long-lived reference on the event loop. The host should
  /// keep the loop alive until a matching unref_loop call. Used by
  /// threadsafe functions to model libuv-style "ref" semantics: while
  /// any tsfn in an env is referenced, the env holds one ref so
  /// producer threads can dispatch into JS without racing the loop's
  /// shutdown.
  ///
  /// Contract: within a single napi_env, ref_loop / unref_loop calls
  /// are paired and NEVER nested — every ref_loop is followed by a
  /// matching unref_loop before the next ref_loop from that env. The
  /// env coalesces all referenced tsfns into one ref/unref pair, so an
  /// env contributes at most one outstanding ref at a time.
  ///
  /// Across distinct envs sharing the same host, multiple unmatched
  /// refs may be in flight concurrently — one per env that has any
  /// referenced tsfn — so the host implementation must accept
  /// concurrent unmatched ref_loop calls (typically via a refcount
  /// or its existing source-tracking mechanism).
  ///
  /// Optional — when null, TSFN ref/unref are tracked for API
  /// compatibility only and have no effect on loop lifetime.
  /// Must be paired with unref_loop.
  void (*ref_loop)(void *loop_data);

  /// Release a long-lived loop reference previously taken by ref_loop.
  /// Optional; null only if ref_loop is also null.
  void (*unref_loop)(void *loop_data);
};

typedef hermes_napi_host hermes_napi_event_loop;

//===========================================================================
// Environment lifecycle (public API)
//===========================================================================

/// Create a new NAPI environment backed by a Hermes Runtime.
/// The \p hermes_runtime parameter is an opaque pointer to a
/// hermes::vm::Runtime instance.
///
/// The env is owned by the Runtime and is automatically torn down and
/// freed when the Runtime is destroyed. The caller must keep the
/// Runtime alive for as long as it uses the returned pointer, and must
/// not free the env itself.
///
/// Finalizer semantics at Runtime teardown:
///
/// Finalizers registered via napi_wrap, napi_add_finalizer,
/// napi_create_external, etc. are guaranteed to be invoked exactly
/// once with the live env that owns the wrapped object. We never
/// invoke user finalizers with env == nullptr.
///
/// Callbacks fire in one of two contexts, both with a non-null env:
///
///   - Unrestricted: the wrapped object was collected while the GC
///     heap was fully functional — either during normal operation
///     (collection happens, callback is drained at the next
///     NAPI_PREAMBLE / drainJobs) or during the env's shutdown
///     phase (cleanup hooks, persistent-reference finalizers, the
///     instance-data finalizer, or thread-safe-function cleanup
///     transitively triggered a GC; the callback is drained at the
///     end of shutdown). The callback may freely allocate, call
///     into JS, and use the env as in any other context.
///
///   - Restricted: the wrapped object was still reachable from JS
///     roots at teardown and was finalized by
///     getHeap().finalizeAll() itself. The callback is drained
///     after finalizeAll, with the GC heap in a post-mortem state.
///     Any NAPI call that would allocate or run JavaScript returns
///     napi_cannot_run_js instead of executing. A spec-conformant
///     finalizer (which only frees native resources — free(),
///     close(), delete, refcount decrement) is unaffected. A
///     finalizer that tries to call back into JS receives the
///     error code and may choose to log it.
///
/// The optional \p host provides host integration callbacks (async work,
/// thread-safe functions, etc.); if nullptr, those APIs return
/// napi_generic_failure.
NAPI_EXTERN napi_env NAPI_CDECL
hermes_napi_create_env(void *hermes_runtime, hermes_napi_host *host = nullptr);

/// Get the last module registered via the deprecated napi_module_register().
/// Returns nullptr if no module has been registered.
NAPI_EXTERN const napi_module *NAPI_CDECL
hermes_napi_get_last_registered_module();

/// Load a NAPI addon from a shared library at \p path.
///
/// This function:
/// 1. Opens the shared library via dlopen().
/// 2. Looks up the `napi_register_module_v1` symbol (modern approach).
///    If not found, falls back to the deprecated `napi_module_register()`
///    approach (checking `hermes_napi_get_last_registered_module()`).
/// 3. Creates an empty `exports` object in the caller's env.
/// 4. Calls the module's init function with (env, exports).
/// 5. Stores the resulting exports object in \p result.
///
/// The caller must provide a valid \p env with an open handle scope.
/// The module's CallbackBundles are owned by the caller's env.
///
/// Returns napi_ok on success, or an error status on failure (with a
/// pending exception set on the env).
NAPI_EXTERN napi_status NAPI_CDECL
hermes_napi_load_module(napi_env env, const char *path, napi_value *result);

//===========================================================================
// Script execution
//===========================================================================

/// Flags for hermes_run_script(). The first field is the struct
/// size for ABI-stable extensibility — newer versions can append
/// fields without breaking older callers.
struct hermes_run_script_flags {
  /// Size of this struct in bytes. Must be set to
  /// sizeof(hermes_run_script_flags) by the caller.
  size_t struct_size;
  /// Run in strict mode.
  bool strict;
  /// Enable TypeScript support.
  bool enable_ts;
  /// Keep the compiled bytecode alive for the lifetime of the Runtime,
  /// even after all references to it are gone.  This lets the engine
  /// avoid copying certain parts of the buffer, resulting in faster
  /// load times.  Do not set this for short-lived modules (e.g. REPL
  /// input) — they would accumulate and never be freed.
  bool persistent;
};

/// Compile and run JavaScript source in a single call.
///
/// \p data and \p size describe a UTF-8 source buffer. If the last
/// byte is '\0', the source is used zero-copy (actual source length
/// is size-1). Otherwise, an internal copy is made to add the null
/// terminator required by the compiler.
///
/// The runtime takes ownership of the buffer: \p finalize_cb is
/// called with (\p data, \p size, \p finalize_hint) when the buffer
/// is no longer needed. Pass NULL for \p finalize_cb if the buffer
/// is static or externally managed.
///
/// \p source_url appears in stack traces (NULL → empty string).
/// \p flags controls compilation options (NULL → all defaults).
///
/// Returns napi_ok on success, napi_pending_exception on JS or
/// compile error.
NAPI_EXTERN napi_status NAPI_CDECL hermes_run_script(
    napi_env env,
    const uint8_t *data,
    size_t size,
    void (*finalize_cb)(const uint8_t *data, size_t size, void *hint),
    void *finalize_hint,
    const char *source_url,
    const hermes_run_script_flags *flags,
    napi_value *result);

//===========================================================================
// Pre-compiled bytecode
//===========================================================================

/// Flags for hermes_run_bytecode(). The first field is the struct
/// size for ABI-stable extensibility — newer versions can append
/// fields without breaking older callers.
struct hermes_bytecode_flags {
  size_t struct_size;
  /// Keep the bytecode alive for the lifetime of the Runtime, even
  /// after all references to it are gone.  This lets the engine avoid
  /// copying certain parts of the buffer, resulting in faster load
  /// times.  Do not set this for short-lived modules (e.g. REPL
  /// input) — they would accumulate and never be freed.
  bool persistent;
  bool hides_epilogue;
  bool funcs_are_builtins;
};

/// Run pre-compiled Hermes bytecode.
///
/// \p data and \p size describe the bytecode buffer. The runtime
/// takes ownership: \p finalize_cb is called with (\p data, \p size,
/// \p finalize_hint) when the buffer is no longer needed. Pass NULL
/// for \p finalize_cb if the buffer is static or externally managed.
///
/// \p source_url appears in stack traces (NULL → empty string).
/// \p flags controls runtime module behavior (NULL → all defaults).
///
/// Returns napi_ok on success, napi_pending_exception on JS error,
/// or napi_generic_failure on bytecode validation failure.
NAPI_EXTERN napi_status NAPI_CDECL hermes_run_bytecode(
    napi_env env,
    const uint8_t *data,
    size_t size,
    void (*finalize_cb)(const uint8_t *data, size_t size, void *hint),
    void *finalize_hint,
    const char *source_url,
    const hermes_bytecode_flags *flags,
    napi_value *result);

#endif // HERMES_NAPI_HERMES_NAPI_H
