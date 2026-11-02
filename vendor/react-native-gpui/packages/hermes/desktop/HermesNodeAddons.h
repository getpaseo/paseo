#pragma once

#include <jsi/jsi.h>

#include <functional>
#include <memory>
#include <string>

namespace facebook::react {
class CallInvoker;
} // namespace facebook::react

namespace rngpui {

/// Builds the engine's NodeAddons loader (GpuiJsEngine.h): one HostContext per
/// runtime, and a function that loads the `.node` file at an absolute path into
/// that runtime and returns its exports. Throws jsi::JSError on failure.
std::function<facebook::jsi::Value(facebook::jsi::Runtime&, const std::string&)>
makeHermesNodeAddonLoader(
    std::shared_ptr<facebook::react::CallInvoker> jsInvoker);

} // namespace rngpui
