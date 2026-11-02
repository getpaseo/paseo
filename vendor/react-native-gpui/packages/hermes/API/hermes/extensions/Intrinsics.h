/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

#include "jsi/jsi.h"

namespace facebook {
namespace hermes {

/// Holds references to built-in JavaScript constructors captured at extension
/// initialization time. This ensures extensions use the original intrinsics
/// even if user code replaces the global properties.
struct ExtensionIntrinsics {
  jsi::Function typeError;
  jsi::Function rangeError;
  jsi::Function uint8Array;

  /// Capture intrinsics from the runtime. Must be called before any user code
  /// executes.
  explicit ExtensionIntrinsics(jsi::Runtime &rt);
};

/// Capture and store intrinsics from the runtime. Must be called before any
/// user code executes.
void captureIntrinsics(jsi::Runtime &rt);

/// Retrieve the stored intrinsics. Throws if captureIntrinsics was not called.
const ExtensionIntrinsics &getIntrinsics(jsi::Runtime &rt);

/// Throw a TypeError with the given message. Uses the intrinsic TypeError
/// constructor captured at initialization time.
[[noreturn]] void throwTypeError(jsi::Runtime &rt, const char *message);

/// Throw a RangeError with the given message. Uses the intrinsic RangeError
/// constructor captured at initialization time.
[[noreturn]] void throwRangeError(jsi::Runtime &rt, const char *message);

} // namespace hermes
} // namespace facebook
