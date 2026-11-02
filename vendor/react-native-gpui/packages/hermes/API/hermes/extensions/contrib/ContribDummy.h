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

/// ContribDummy extension - example community contribution.
/// Does nothing - serves as a template for contrib extensions.
///
/// \param runtime The JSI runtime to install into.
/// \param extensions The precompiled extensions object containing setup
///   functions.
void installContribDummy(jsi::Runtime &runtime, jsi::Object &extensions);

} // namespace hermes
} // namespace facebook
