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

/// Install the TextEncoder constructor on the global object.
/// This creates a proper TextEncoder class conforming to the WHATWG Encoding
/// Standard with:
///   - constructor (callable with 'new TextEncoder()')
///   - encoding getter (always returns "utf-8")
///   - encode(string) method returning Uint8Array
///   - encodeInto(string, Uint8Array) method returning {read, written}
///
/// \param runtime The JSI runtime to install into.
/// \param extensions The precompiled extensions object containing setup
///   functions.
void installTextEncoder(jsi::Runtime &runtime, jsi::Object &extensions);

} // namespace hermes
} // namespace facebook
