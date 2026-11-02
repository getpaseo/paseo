/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once
#ifdef JSI_UNSTABLE
#ifndef HERMES_EXTENSIONS_WORKER_H
#define HERMES_EXTENSIONS_WORKER_H

#include <jsi/jsi.h>

namespace facebook {
namespace hermes {

/// Install the Worker constructor on the global object.
/// \param runtime The JSI runtime to install into.
/// \param extensions The precompiled extensions object containing setup
///   functions.
void installWorker(jsi::Runtime &rt, jsi::Object &extensions);

} // namespace hermes
} // namespace facebook

#endif // HERMES_EXTENSIONS_WORKER_H
#endif // JSI_UNSTABLE
