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

/// Dummy extension for testing precompiled extension system.
/// Does nothing - just validates the multi-extension architecture.
///
/// \param runtime The JSI runtime to install into.
/// \param extensions The precompiled extensions object containing setup
///   functions.
void installDummy(jsi::Runtime &runtime, jsi::Object &extensions);

} // namespace hermes
} // namespace facebook
