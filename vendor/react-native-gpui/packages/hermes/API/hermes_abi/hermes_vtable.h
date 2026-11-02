/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#ifndef HERMES_ABI_HERMES_VTABLE_H
#define HERMES_ABI_HERMES_VTABLE_H

#ifdef __cplusplus
extern "C" {
#endif

struct HermesABIVTable;

/// Obtain the VTable implementation for Hermes' C-API.
#ifdef _MSC_VER
__declspec(dllexport)
#else // _MSC_VER
__attribute__((visibility("default")))
#endif // _MSC_VER
const struct HermesABIVTable *get_hermes_abi_vtable();

#ifdef __cplusplus
}
#endif

#endif
