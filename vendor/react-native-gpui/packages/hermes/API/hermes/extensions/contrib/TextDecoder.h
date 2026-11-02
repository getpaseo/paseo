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

/// Install the TextDecoder constructor on the global object.
/// This creates a proper TextDecoder class conforming to the WHATWG Encoding
/// Standard with:
///   - constructor (callable with 'new TextDecoder(label, options)')
///   - encoding getter (returns the encoding name)
///   - fatal getter (returns the fatal flag)
///   - ignoreBOM getter (returns the ignoreBOM flag)
///   - decode(input, options) method returning a string
///
/// \param runtime The JSI runtime to install into.
/// \param extensions The precompiled extensions object containing setup
///   functions.
void installTextDecoder(jsi::Runtime &runtime, jsi::Object &extensions);

} // namespace hermes
} // namespace facebook
