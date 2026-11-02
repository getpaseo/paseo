/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

#include <jsi/jsi.h>

namespace facebook {
namespace hermes {

/// Install all JSI extensions (TextEncoder, etc.) into the runtime.
/// The extensions object is passed in from the caller who loaded the bytecode.
void installExtensions(jsi::Runtime &rt, jsi::Object extensions);

} // namespace hermes
} // namespace facebook
