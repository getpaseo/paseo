/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#ifndef HERMES_ABI_HERMES_ABI_RUNTIME_WRAPPER_H
#define HERMES_ABI_HERMES_ABI_RUNTIME_WRAPPER_H

#include <hermes/Public/HermesExport.h>
#include <jsi/jsi.h>

struct HermesABIVTable;

namespace facebook {
namespace hermes {
/// Create a jsi::Runtime by wrapping the C-API implementation provided by
/// \p vtable.
HERMES_EXPORT std::unique_ptr<facebook::jsi::Runtime>
makeHermesABIRuntimeWrapper(const HermesABIVTable *vtable);
} // namespace hermes
} // namespace facebook

#endif // HERMES_ABI_HERMES_ABI_RUNTIME_WRAPPER_H
