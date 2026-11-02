#pragma once

#include <jsi/jsi.h>

#include <memory>

namespace facebook::react {
class CallInvoker;
} // namespace facebook::react

namespace rngpui {

/// Installs the `_requireNodeLibrary(key, path)` JSI global on `runtime`.
///
/// Called once per runtime, on the JS thread, before the app bundle runs — a
/// reload creates a new runtime and reinstalls it, so the addon cache (which
/// lives on that runtime's global object) starts empty, as Node does for a new
/// context.
///
/// `jsInvoker` schedules work on this runtime's JS thread; it is handed to the
/// engine, which owns the Node-API host callbacks (async work, thread-safe
/// functions).
///
/// Core owns everything else: resolving `key` to a file, the cache of loaded
/// exports, and the error messages, including the one used when the active
/// engine has no NodeAddons capability.
void installNodeAddons(
    facebook::jsi::Runtime& runtime,
    std::shared_ptr<facebook::react::CallInvoker> jsInvoker);

} // namespace rngpui
