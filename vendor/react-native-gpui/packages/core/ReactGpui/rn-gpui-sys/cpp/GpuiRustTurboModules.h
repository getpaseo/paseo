#pragma once

#include <cstdint>

#include <rust/cxx.h>

namespace rngpui {

/// Installs the provider that serves Rust TurboModules by name. Called once,
/// from the host, before any module is asked for.
void install_rust_turbo_modules();

/// Settles the JS promise of a Rust module call with the value built in
/// `scope` at `root`. `request` identifies the promise; an unknown request is
/// discarded, which is what a reload leaves behind.
void rn_gpui_rust_module_result(
    int32_t request,
    bool ok,
    uint32_t scope,
    uint32_t root,
    rust::String code,
    rust::String message);

/// Calls a JS function a Rust module kept; `scope`/`root` hold its arguments.
void rn_gpui_rust_callback_invoke(uint64_t id, uint32_t scope, uint32_t root);

void rn_gpui_rust_callback_drop(uint64_t id);

/// Emits a typed spec event; `has_value` says whether `scope`/`root` carry a
/// payload.
void rn_gpui_rust_module_emit(
    uint64_t handle,
    rust::Str event,
    bool has_value,
    uint32_t scope,
    uint32_t root);

void rn_gpui_rust_module_send_event(
    uint64_t handle,
    rust::Str name,
    uint32_t scope,
    uint32_t root);

/// Drops the promises and JS functions of the runtime that is going away.
void rn_gpui_rust_module_clear_pending();

} // namespace rngpui
