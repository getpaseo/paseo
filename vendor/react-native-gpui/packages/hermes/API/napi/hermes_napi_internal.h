/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#ifndef HERMES_NAPI_HERMES_NAPI_INTERNAL_H
#define HERMES_NAPI_HERMES_NAPI_INTERNAL_H

#include "hermes_napi_impl.h"

#include "hermes/VM/Callable.h"
#include "hermes/VM/HandleRootOwner.h"
#include "hermes/VM/StringPrimitive.h"

/// Helper: capture the runtime's thrown value as a NAPI pending
/// exception and return \p status.
inline napi_status captureRuntimeException(napi_env env, napi_status status) {
  env->pendingException = env->runtime.getThrownValue();
  env->hasPendingException = true;
  env->runtime.clearThrownValue();
  return napi_set_last_error(env, status);
}

/// Helper: intern a UTF-8 name as a SymbolID. The name is first
/// created as a StringPrimitive (handling all UTF-8 correctly), then
/// interned via the identifier table. Returns the SymbolID via
/// \p symRes. On failure, captures the runtime exception and returns
/// the error status. Requires an active GCScope.
inline napi_status internUtf8AsSymbol(
    napi_env env,
    const char *utf8name,
    hermes::vm::CallResult<hermes::vm::Handle<hermes::vm::SymbolID>> &symRes) {
  using namespace hermes::vm;

  Runtime &runtime = env->runtime;

  // Create a StringPrimitive from the UTF-8 name.
  auto strRes = StringPrimitive::createEfficient(
      runtime,
      UTF8Ref(
          reinterpret_cast<const uint8_t *>(utf8name), std::strlen(utf8name)));
  if (LLVM_UNLIKELY(strRes == ExecutionStatus::EXCEPTION)) {
    return captureRuntimeException(env, napi_pending_exception);
  }

  // Intern the string to get a SymbolID.
  symRes = runtime.getIdentifierTable().getSymbolHandleFromPrimitive(
      runtime,
      PseudoHandle<StringPrimitive>::create(vmcast<StringPrimitive>(*strRes)));
  if (LLVM_UNLIKELY(symRes == ExecutionStatus::EXCEPTION)) {
    return captureRuntimeException(env, napi_pending_exception);
  }

  return napi_ok;
}

/// Linked list node for finalizer callbacks (napi_add_finalizer).
struct NapiFinalizerEntry {
  void *data;
  napi_finalize finalize_cb;
  void *finalize_hint;
  NapiFinalizerEntry *next;
};

/// Consolidated per-object NAPI data. One allocation backs all of
/// napi_wrap, napi_add_finalizer, and napi_type_tag_object.
struct NapiObjectData {
  napi_env env;

  // -- Wrap (napi_wrap) --
  bool hasWrap = false;
  void *wrapData = nullptr;
  napi_finalize wrapFinalizeCb = nullptr;
  void *wrapFinalizeHint = nullptr;

  // -- Type tag (napi_type_tag_object) --
  bool hasTypeTag = false;
  uint64_t typeTagLower = 0;
  uint64_t typeTagUpper = 0;

  // -- Finalizer chain (napi_add_finalizer) --
  NapiFinalizerEntry *finalizerChain = nullptr;
};

/// Read-only lookup for NapiObjectData on an object. Returns the
/// NapiObjectData pointer in *outData, or nullptr if none exists.
/// Returns napi_invalid_arg if js_object is not an object.
/// Defined in hermes_napi_wrap.cpp.
napi_status
getNapiObjectData(napi_env env, napi_value js_object, NapiObjectData **outData);

/// Lazy-creation lookup for NapiObjectData on an object. If the
/// internal property is absent, creates a new NapiObjectData and
/// defines the property. Caller must provide an active GCScope.
/// Defined in hermes_napi_wrap.cpp.
napi_status getOrCreateNapiObjectData(
    napi_env env,
    hermes::vm::Handle<hermes::vm::JSObject> objHandle,
    NapiObjectData **outData);

/// The trampoline function that bridges Hermes's NativeFunctionPtr
/// signature with NAPI's napi_callback signature. Defined in
/// hermes_napi_function.cpp but declared here so it can be used from
/// other translation units (e.g., hermes_napi_object.cpp for
/// napi_define_properties).
hermes::vm::CallResult<hermes::vm::HermesValue> napiFunctionTrampoline(
    void *context,
    hermes::vm::Runtime &runtime);

/// Constructor trampoline for NAPI functions. Handles both regular calls
/// and constructor calls (creating a 'this' object when called via 'new').
/// Defined in hermes_napi_function.cpp.
hermes::vm::CallResult<hermes::vm::HermesValue> napiConstructorTrampoline(
    void *context,
    hermes::vm::Runtime &runtime);

/// Helper: create a NativeFunction wrapping a napi_callback for use as
/// a method, getter, or setter in napi_define_properties and
/// napi_define_class. The callback bundle is stored in the env's deque
/// for lifetime management. Requires an active GCScope. Defined in
/// hermes_napi_object.cpp.
napi_status createNapiNativeFunction(
    napi_env env,
    napi_callback cb,
    void *data,
    hermes::vm::SymbolID name,
    unsigned paramCount,
    hermes::vm::PseudoHandle<hermes::vm::NativeFunction> &out);

/// Check if a HermesValue is a NAPI external (DecoratedObject, not
/// HostObject). Defined in hermes_napi_external.cpp.
bool isNapiExternal(hermes::vm::HermesValue hv);

/// Set the type tag on a NAPI external value. Returns napi_invalid_arg
/// if the tag is already set. Defined in hermes_napi_external.cpp.
napi_status napiExternalSetTypeTag(
    napi_env env,
    hermes::vm::HermesValue hv,
    const napi_type_tag *type_tag);

/// Check the type tag on a NAPI external value. Sets *result to true
/// if the tag matches. Defined in hermes_napi_external.cpp.
napi_status napiExternalCheckTypeTag(
    napi_env env,
    hermes::vm::HermesValue hv,
    const napi_type_tag *type_tag,
    bool *result);

#endif // HERMES_NAPI_HERMES_NAPI_INTERNAL_H
