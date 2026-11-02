/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#ifndef HERMES_NAPI_HERMES_NAPI_IMPL_H
#define HERMES_NAPI_HERMES_NAPI_IMPL_H

#include "hermes_napi.h"

#include "hermes/VM/HermesValue.h"
#include "hermes/VM/Runtime.h"
#include "hermes/VM/WeakRef.h"

#include <cassert>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

//===========================================================================
// Callback info
//===========================================================================

/// The callback info structure passed to NAPI callbacks.
/// This is stack-allocated by the native function trampoline and holds
/// all the data that napi_get_cb_info and napi_get_new_target need.
///
/// The \c thisArg pointer points to the 'this' value — either on the
/// register stack (for regular calls) or in a handle scope slot (for
/// constructor calls where a new 'this' object is synthesized).
/// The \c argsBase pointer always points to the 'this' slot on the
/// register stack, so that arguments can be accessed at argsBase[-(i+1)].
struct napi_callback_info__ {
  /// The NAPI environment.
  napi_env env;

  /// Pointer to the 'this' PinnedHermesValue. For regular calls this
  /// points into the register stack; for constructor calls it may
  /// point into a handle scope slot.
  const hermes::vm::PinnedHermesValue *thisArg;

  /// Pointer to the 'this' slot on the register stack. Arguments are
  /// at argsBase[-(i+1)]. This always points to the register stack,
  /// even for constructor calls.
  const hermes::vm::PinnedHermesValue *argsBase;

  /// Number of JavaScript arguments (excluding 'this').
  unsigned argc;

  /// User data pointer from napi_create_function.
  void *data;

  /// Pointer to the new.target PinnedHermesValue in the register stack.
  /// Contains undefined for regular function calls.
  const hermes::vm::PinnedHermesValue *newTarget;

  /// Get the i-th argument. Returns the HermesValue directly from the
  /// register stack if i < argc, otherwise returns undefined.
  hermes::vm::HermesValue getArg(unsigned i) const {
    // Args are stored at decreasing addresses from argsBase.
    // arg[i] is at argsBase[-(i+1)].
    return i < argc
        ? static_cast<hermes::vm::HermesValue>(argsBase[-(int)(i + 1)])
        : hermes::vm::HermesValue::encodeUndefinedValue();
  }
};

//===========================================================================
// Callback bundle
//===========================================================================

/// Data associated with each NAPI native function. Stored in a list
/// owned by napi_env__ and pointed to by the NativeFunction's context.
/// The bundle is allocated when napi_create_function is called and freed
/// when the env is destroyed.
struct CallbackBundle {
  napi_env env;
  napi_callback cb;
  void *data;
};

//===========================================================================
// Handle scope storage
//===========================================================================

/// A fixed-size block of PinnedHermesValue slots used for handle storage.
/// Once allocated, the block never moves in memory, so pointers to individual
/// slots (returned as napi_value) remain valid for the block's lifetime.
struct HandleBlock {
  /// Number of slots per block. Chosen for cache efficiency while
  /// keeping per-scope overhead low.
  static constexpr size_t kSize = 64;

  hermes::vm::PinnedHermesValue slots[kSize];
};

/// Descriptor for an open handle scope. Records the position in the handle
/// storage at the time the scope was opened, so that closing the scope can
/// reclaim all handles allocated since then.
struct HandleScopeDescriptor {
  /// Index of the active block when this scope was opened.
  size_t blockIndex;

  /// Number of used slots in that block when this scope was opened.
  size_t slotIndex;

  /// Whether this is an escapable scope.
  bool escapable = false;

  /// Whether napi_escape_handle has been called on this scope.
  bool escapeCalled = false;

  /// For escapable scopes: pointer to the pre-allocated slot in the
  /// parent scope where the escaped value will be stored.
  hermes::vm::PinnedHermesValue *escapeSlot = nullptr;
};

//===========================================================================
// napi_deferred__ definition
//===========================================================================

/// A deferred promise resolution. Stores the resolve and reject functions
/// captured from the Promise constructor's executor callback. These are
/// GC roots, marked by the env's custom roots function while the deferred
/// is active. The deferred is consumed (deleted) when
/// napi_resolve_deferred or napi_reject_deferred is called.
///
/// Deferreds are stored in a doubly-linked list in the env for GC root
/// enumeration and cleanup.
struct napi_deferred__ {
  /// The resolve function from the Promise executor.
  hermes::vm::PinnedHermesValue resolve{};

  /// The reject function from the Promise executor.
  hermes::vm::PinnedHermesValue reject{};

  /// Doubly-linked list pointers for the env's deferred list.
  napi_deferred__ *prev_ = nullptr;
  napi_deferred__ *next_ = nullptr;
};

//===========================================================================
// napi_ref__ definition
//===========================================================================

/// A persistent reference to a JavaScript value that can be either strong
/// (prevents GC, refcount > 0) or weak (allows GC, refcount == 0).
///
/// Strong references: The \c value field is marked as a GC root by the
/// env's custom roots function. The referenced value will not be collected.
///
/// Weak references: For pointer types (objects, strings, bigints), a
/// \c WeakRef<GCCell> tracks GC liveness through a \c WeakRefSlot. The
/// \c value field is NOT marked as a root, so the GC may collect the
/// referent. For non-pointer types (numbers, booleans, undefined, null,
/// symbols), no GC tracking is needed — these values are always valid.
///
/// References are stored in a doubly-linked list in the env for GC root
/// enumeration and cleanup.
/// A reference to a JS value with controllable prevent-collection semantics.
///
/// Three states, defined by (refcount, weakSlot_):
///
/// 1. Strong (refcount > 0, weakSlot_ == nullptr):
///    `value` holds the referenced value and is marked as a GC root.
///
/// 2. Weak (refcount == 0, weakSlot_ != nullptr):
///    `value` is undefined. The actual value lives in the weak slot, which
///    the GC tracks — updating it if the object moves, or invalidating it
///    if collected. All value types (objects, strings, numbers, booleans,
///    symbols, etc.) go through the weak slot uniformly.
///
/// 3. Known dead (refcount == 0, weakSlot_ == nullptr):
///    `value` is undefined. The referent was collected. Permanent state:
///    napi_reference_ref is a no-op returning 0, napi_get_reference_value
///    returns NULL.
///
/// Transitions:
///   1→2: napi_reference_unref to refcount 0. Value moves to a new slot.
///   2→1: napi_reference_ref when slot is alive. Value restored from slot.
///   2→3: napi_reference_ref when slot is dead, or env teardown.
struct napi_ref__ {
  napi_env env;

  /// Reference count. >0 means strong (GC root), ==0 means weak.
  uint32_t refcount;

  /// When strong (refcount > 0), contains the referenced value and is
  /// marked as a GC root. When weak (refcount == 0), always undefined —
  /// the actual value lives in the weakSlot_.
  hermes::vm::PinnedHermesValue value{};

  /// When weak: tracks the value and its liveness. The GC updates or
  /// invalidates the slot as needed. Null for strong refs or for weak
  /// refs that are known dead (referent was collected).
  hermes::vm::WeakRefSlot *weakSlot_ = nullptr;

  /// Doubly-linked list pointers for the env's reference list.
  napi_ref__ *prev_ = nullptr;
  napi_ref__ *next_ = nullptr;

  /// Optional destructor callback. Called during GC or env teardown,
  /// but NOT by napi_delete_reference (matching V8 behavior).
  napi_finalize finalize_cb = nullptr;
  void *finalize_data = nullptr;
  void *finalize_hint = nullptr;

  /// Set to true when this reference is being cleaned up during env
  /// teardown. Prevents re-entrant deletion when a finalizer calls
  /// napi_delete_reference on the same reference being finalized.
  bool deletionPending_ = false;

  /// Return true if this is a strong reference (refcount > 0).
  bool isStrong() const {
    return refcount > 0;
  }

  /// Move the value into a weak slot. Called when transitioning from
  /// strong to weak, or when creating a new weak reference.
  void createWeakSlot(hermes::vm::Runtime &runtime) {
    assert(!weakSlot_ && "weak slot already exists");
    auto shv = hermes::vm::SmallHermesValue::encodeHermesValue(value, runtime);
    weakSlot_ = runtime.getHeap().allocWeakSlot(shv);
    value = hermes::vm::HermesValue::encodeUndefinedValue();
  }

  /// Release the weak slot. Called when transitioning from weak to
  /// strong, or when the reference is deleted.
  void releaseWeakSlot() {
    if (weakSlot_) {
      weakSlot_->free();
      weakSlot_ = nullptr;
    }
  }

  /// Check if the weak reference is still valid (referent not collected).
  /// Strong refs are always valid. Weak refs with no slot are known dead.
  bool isWeakValid() const {
    if (isStrong())
      return true;
    if (!weakSlot_)
      return false; // known dead
    return weakSlot_->hasValue();
  }

  /// Get the referenced value from the weak slot, with a read barrier.
  /// Only valid when the weak slot exists and hasValue() is true.
  hermes::vm::HermesValue getWeakValue(hermes::vm::Runtime &runtime) const {
    assert(weakSlot_ && "no weak slot");
    assert(weakSlot_->hasValue() && "weak ref is dead");
    return weakSlot_->getValue(runtime, runtime.getHeap());
  }
};

//===========================================================================
// napi_async_cleanup_hook_handle__ definition
//===========================================================================

/// Handle for an async cleanup hook registered via
/// napi_add_async_cleanup_hook. Stores the user's hook function and
/// data, and is linked into the env's asyncCleanupHooks_ list.
/// During env teardown, the hook is called with this handle (so it can
/// call napi_remove_async_cleanup_hook) and the user data.
struct napi_async_cleanup_hook_handle__ {
  napi_env env;
  napi_async_cleanup_hook hook;
  void *arg;
};

//===========================================================================
// napi_env__ definition
//===========================================================================

/// The core environment structure for the Hermes NAPI implementation.
/// Each napi_env holds a reference to a Hermes VM Runtime and manages
/// error state, pending exceptions, handle scopes, and (in future phases)
/// persistent references and cleanup hooks.
struct napi_env__ {
  /// Create a new NAPI environment backed by the given Runtime.
  /// The Runtime's lifetime must exceed this env's lifetime.
  /// The optional \p host provides host integration callbacks.
  explicit napi_env__(
      hermes::vm::Runtime &runtime,
      hermes_napi_host *host = nullptr);

  /// Destructor.
  ~napi_env__();

  /// Non-copyable, non-movable.
  napi_env__(const napi_env__ &) = delete;
  napi_env__ &operator=(const napi_env__ &) = delete;

  //--- Handle scope management ---

  /// Allocate a new PinnedHermesValue slot in the current (topmost) handle
  /// scope, store \p val in it, and return a pointer to the slot. The
  /// returned pointer is valid until the enclosing handle scope is closed.
  /// Returns nullptr if no handle scope is open.
  napi_value addToCurrentScope(hermes::vm::HermesValue val);

  /// Mark all live handle scope slots as GC roots via \p acceptor.
  void markHandleScopes(hermes::vm::RootAcceptor &acceptor);

  //--- Deferred finalization ---

  /// Queue a finalizer callback for deferred execution outside GC.
  /// Called from GC finalizers (NativeState, DecoratedObject) which
  /// must not call back into JS during GC sweep.
  void queuePendingFinalizer(napi_finalize cb, void *data, void *hint);

  /// Drain all pending finalizer callbacks. Called at safe points
  /// outside of GC (NAPI_PREAMBLE, env teardown) to execute the
  /// queued callbacks.
  void drainPendingFinalizers();

  /// Drive substantive shutdown of this environment. Drains pending
  /// finalizers, runs cleanup hooks, finalizes persistent references,
  /// runs the instance data finalizer, and tears down deferreds and
  /// thread-safe functions. Registered as a Runtime shutdown
  /// callback so it runs before Runtime::~Runtime calls
  /// getHeap().finalizeAll(), with a fully functional heap.
  ///
  /// User code invoked here (cleanup hooks, ref finalizers, etc.)
  /// may transitively trigger GC, which queues wrap callbacks via
  /// finalizeNapiObjectData. A final drainPendingFinalizers() at
  /// the end of shutdown() runs those callbacks while the heap is
  /// still fully functional, so they have unrestricted env access.
  ///
  /// After this returns, the env structure still exists (it must
  /// outlive finalizeAll so finalizeNapiObjectData can call
  /// queuePendingFinalizer for wrapped objects still alive at
  /// teardown). Only callbacks queued by finalizeAll itself end
  /// up in the Runtime's post-shutdown deleter, where
  /// inPostShutdownDrain_ is set and NAPI calls that would
  /// allocate or run JS return napi_cannot_run_js.
  void shutdown();

  //--- Reference management ---

  /// Add a reference to the env's linked list.
  void addReference(napi_ref__ *ref);

  /// Remove a reference from the env's linked list.
  void removeReference(napi_ref__ *ref);

  /// Mark all strong references as GC roots via \p acceptor.
  void markReferences(hermes::vm::RootAcceptor &acceptor);

  //--- Deferred management ---

  /// Add a deferred to the env's linked list for GC root marking.
  void addDeferred(napi_deferred__ *def);

  /// Remove a deferred from the env's linked list.
  void removeDeferred(napi_deferred__ *def);

  /// Mark all active deferreds as GC roots via \p acceptor.
  void markDeferreds(hermes::vm::RootAcceptor &acceptor);

  //--- Thread-safe function management ---

  /// Add a TSFN to the env's linked list for GC root marking.
  void addTsfn(napi_threadsafe_function__ *tsfn);

  /// Remove a TSFN from the env's linked list.
  void removeTsfn(napi_threadsafe_function__ *tsfn);

  /// Mark all active TSFNs as GC roots via \p acceptor.
  void markTsfns(hermes::vm::RootAcceptor &acceptor);

  /// Acquire a tsfn loop reference. On the 0 → 1 transition, calls
  /// host->ref_loop. On other increments, just bumps the counter.
  void acquireTsfnLoopRef();

  /// Release a tsfn loop reference. On the 1 → 0 transition, calls
  /// host->unref_loop. On other decrements, just lowers the counter.
  void releaseTsfnLoopRef();

  /// The Hermes VM runtime this environment is bound to.
  hermes::vm::Runtime &runtime;

  /// Last error information returned by napi_get_last_error_info.
  napi_extended_error_info last_error{};

  /// Whether there is a pending JavaScript exception.
  bool hasPendingException = false;

  /// Storage for the pending JavaScript exception value.
  /// This is a GC root — it is marked during GC via the custom roots
  /// function registered in the constructor.
  hermes::vm::PinnedHermesValue pendingException{};

  /// Module API version. Defaults to NAPI_VERSION.
  int32_t module_api_version = NAPI_VERSION;

  /// Number of currently open handle scopes (for validation).
  int open_handle_scopes = 0;

  /// Stack of open handle scope descriptors (LIFO).
  std::vector<HandleScopeDescriptor> scopeStack_;

  /// Pool of handle blocks. Blocks are allocated on demand and reused
  /// across scope open/close cycles to avoid repeated allocation.
  /// Pointers to slots within these blocks are handed out as napi_value.
  std::vector<std::unique_ptr<HandleBlock>> blocks_;

  /// Index of the current (partially filled) block in blocks_.
  size_t currentBlockIndex_ = 0;

  /// Number of slots used in the current block.
  size_t currentSlotIndex_ = 0;

  /// Callback bundles for native functions. Each bundle is owned by the
  /// env and freed when the env is destroyed. We use a deque so that
  /// pointers to bundles (stored as NativeFunction context) remain stable.
  std::deque<CallbackBundle> callbackBundles_;

  /// Head of the doubly-linked list of persistent references (napi_ref).
  /// Used for GC root marking (strong refs) and cleanup on env destruction.
  napi_ref__ *refListHead_ = nullptr;

  /// Head of the doubly-linked list of active deferreds (napi_deferred).
  /// Used for GC root marking of resolve/reject functions.
  napi_deferred__ *deferredListHead_ = nullptr;

  /// The file name of the loaded NAPI module (set by
  /// hermes_napi_load_module). Used by node_api_get_module_file_name.
  std::string moduleFileName_;

  /// Registered environment cleanup hooks (LIFO order on teardown).
  /// Each entry is a {function, arg} pair. Called in reverse order
  /// during env destruction, before finalizers and other cleanup.
  std::vector<std::pair<napi_cleanup_hook, void *>> cleanupHooks_;

  /// Registered async cleanup hooks (LIFO order on teardown).
  /// Each entry is a heap-allocated handle. Called in reverse order
  /// during env destruction, after sync cleanup hooks.
  std::vector<napi_async_cleanup_hook_handle__ *> asyncCleanupHooks_;

  /// Per-environment instance data (set by napi_set_instance_data).
  void *instanceData_ = nullptr;

  /// Finalizer callback for instance data, called on env destruction or
  /// when replaced by a new napi_set_instance_data call.
  napi_finalize instanceDataFinalizeCb_ = nullptr;

  /// Hint passed to the instance data finalizer.
  void *instanceDataFinalizeHint_ = nullptr;

  /// Optional host integration interface provided by the host
  /// application. When non-null, enables async work APIs
  /// (napi_queue_async_work, napi_cancel_async_work) and thread-safe
  /// functions. When null, those APIs return napi_generic_failure.
  /// Owned by the host; must outlive this env.
  hermes_napi_host *host_ = nullptr;

  /// Number of currently open callback scopes (for validation in
  /// napi_close_callback_scope).
  int open_callback_scopes = 0;

  /// Cumulative external memory hint (bytes) reported via
  /// napi_adjust_external_memory. Hermes GC does not support global
  /// external memory hints (its API requires a specific GCCell), so
  /// this counter is maintained for reporting purposes only.
  int64_t externalMemory_ = 0;

  /// Head of the doubly-linked list of active thread-safe functions.
  /// Used for GC root marking of JS function values.
  napi_threadsafe_function__ *tsfnListHead_ = nullptr;

  /// Number of currently referenced thread-safe functions in this env.
  /// While > 0, this env holds one host loop reference via host->ref_loop.
  /// Incremented by tsfn create (when is_ref) and napi_ref_tsfn;
  /// decremented by napi_unref_tsfn and tsfn finalize.
  ///
  /// The env coalesces all referenced tsfns into a single host
  /// ref_loop / unref_loop pair — see the contract on hermes_napi_host.
  int activeTsfnLoopRefs_ = 0;

  /// A pending finalizer callback queued during GC for deferred execution.
  struct PendingFinalizer {
    napi_finalize cb;
    void *data;
    void *hint;
  };

  /// Queue of finalizer callbacks deferred from GC sweep. GC finalizers
  /// must not call back into JS (GC reentrancy), so they queue their
  /// callbacks here. The queue is drained at safe points via
  /// drainPendingFinalizers().
  std::vector<PendingFinalizer> pendingFinalizers_;

  /// Guards pendingFinalizers_ and drainingFinalizers_. Hades GC can queue
  /// finalizers from a background thread while the JS thread drains them.
  std::mutex pendingFinalizersMutex_;

  /// True while drainPendingFinalizers() is executing, to prevent
  /// re-entrant draining (a callback may trigger GC which queues more).
  bool drainingFinalizers_ = false;

  /// True while running the final post-finalizeAll drain in the
  /// post-shutdown deleter. Set by the deleter before invoking
  /// drainPendingFinalizers() and never cleared (the env is deleted
  /// immediately after).
  ///
  /// At this point Runtime::~Runtime has already called
  /// getHeap().finalizeAll(), so the GC heap is in a post-mortem
  /// state — allocating new JS values or triggering a collection
  /// would re-finalize already-finalized cells (UB). NAPI_PREAMBLE
  /// returns napi_cannot_run_js when this flag is set, so any
  /// finalizer callback that calls back into JS gets a defined
  /// error instead of an undefined crash. Spec-conformant
  /// finalizers (which only free native resources) ignore the
  /// return and complete normally.
  bool inPostShutdownDrain_ = false;
};

//===========================================================================
// Internal helper functions
//===========================================================================

/// Clear the last error state in the environment.
inline napi_status napi_clear_last_error(node_api_basic_env env) {
  env->last_error.error_code = napi_ok;
  env->last_error.engine_error_code = 0;
  env->last_error.engine_reserved = nullptr;
  env->last_error.error_message = nullptr;
  return napi_ok;
}

/// Set the last error state in the environment and return the error code.
inline napi_status napi_set_last_error(
    node_api_basic_env env,
    napi_status error_code,
    uint32_t engine_error_code = 0,
    void *engine_reserved = nullptr) {
  env->last_error.error_code = error_code;
  env->last_error.engine_error_code = engine_error_code;
  env->last_error.engine_reserved = engine_reserved;
  return error_code;
}

//===========================================================================
// Argument checking macros
//===========================================================================

/// Return napi_invalid_arg if env is null, or napi_cannot_run_js if
/// the env is in its post-shutdown drain (running queued finalizers
/// after Runtime::~Runtime's finalizeAll). At that point the GC heap
/// is in a post-mortem state; allocating new JS values or calling
/// into JS would re-finalize already-finalized cells. The flag
/// gives finalizer callbacks that try to call back into JS a defined
/// error instead of an undefined crash. Spec-conformant finalizers
/// (which only free native resources) never see this code.
#define CHECK_ENV(env)               \
  do {                               \
    if ((env) == nullptr) {          \
      return napi_invalid_arg;       \
    }                                \
    if ((env)->inPostShutdownDrain_) \
      return napi_cannot_run_js;     \
  } while (0)

/// Return the given status if the condition is false.
#define RETURN_STATUS_IF_FALSE(env, condition, status) \
  do {                                                 \
    if (!(condition)) {                                \
      return napi_set_last_error((env), (status));     \
    }                                                  \
  } while (0)

/// Return napi_invalid_arg if the argument is null.
#define CHECK_ARG(env, arg) \
  RETURN_STATUS_IF_FALSE((env), ((arg) != nullptr), napi_invalid_arg)

/// Propagate a non-ok status from a NAPI call.
#define STATUS_CALL(call)        \
  do {                           \
    napi_status status = (call); \
    if (status != napi_ok)       \
      return status;             \
  } while (0)

/// Preamble for NAPI functions that may call into JavaScript.
/// Validates env, checks for pending exceptions, and clears last error.
/// Functions that are exception-safe (handle scopes, error info, getters
/// for singletons, type checks, value extraction) should use CHECK_ENV
/// instead.
///
/// CHECK_ENV (called first) returns napi_cannot_run_js if the env is
/// in its post-shutdown drain, so finalizer callbacks that try to call
/// back into JS get a defined error instead of triggering re-finalization.
#define NAPI_PREAMBLE(env)                                           \
  do {                                                               \
    CHECK_ENV((env));                                                \
    (env)->drainPendingFinalizers();                                 \
    RETURN_STATUS_IF_FALSE(                                          \
        (env), !(env)->hasPendingException, napi_pending_exception); \
    napi_clear_last_error((env));                                    \
  } while (0)

#endif // HERMES_NAPI_HERMES_NAPI_IMPL_H
