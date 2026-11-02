/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

#include "GpuiJsEngine.h"

#include <jsi/jsi.h>
#include <react/runtime/JSRuntimeFactory.h>

#include <memory>
#include <utility>

namespace facebook::react::tests {

/// Creates the JSI runtime a test should use from `factory` — the same seam
/// ReactHost uses for every (re)load. Tests take a factory instead of
/// constructing a VM of their own, so no test depends on an engine.
inline std::unique_ptr<JSRuntime> createTestRuntime(
    JSRuntimeFactory& factory,
    std::shared_ptr<MessageQueueThread> messageQueueThread = nullptr) {
  return factory.createJSRuntime(std::move(messageQueueThread));
}

/// The same runtime, built from the engine the test binary registered. A test
/// binary registers an engine package exactly like an app does (see
/// GpuiJsEngine.h); without one this reports the registry's error.
inline std::unique_ptr<JSRuntime> createTestRuntimeFromActiveEngine(
    std::shared_ptr<MessageQueueThread> messageQueueThread = nullptr) {
  return createTestRuntime(
      *rngpui::activeJsEngine().makeRuntimeFactory(),
      std::move(messageQueueThread));
}

} // namespace facebook::react::tests
