/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#ifndef HERMES_NAPI_HERMES_NAPI_COMPILE_H
#define HERMES_NAPI_HERMES_NAPI_COMPILE_H

#include "hermes/napi/node_api.h"

#include <stddef.h>

/// Flags for hermes_compile_to_bytecode(). The first field is the struct
/// size for ABI-stable extensibility — newer versions can append
/// fields without breaking older callers.
struct hermes_compile_flags {
  size_t struct_size;
  /// Parse in strict mode.
  bool strict;
  /// Run the full optimization pipeline on the compiled IR.
  bool optimize;
  /// Emit async break check instructions, e.g. for enforcing execution
  /// time limits.
  bool emit_async_break_check;
  /// Enable TypeScript support.
  bool enable_ts;
};

/// Compile JavaScript source to serialized Hermes bytecode.
///
/// \p source and \p source_size describe the UTF-8 source buffer.
/// For best performance, include the null terminator in the buffer
/// (i.e. source[source_size - 1] == '\0'); the actual source text is
/// then source_size - 1 bytes. If the buffer does not end with '\0',
/// the function makes an internal copy to add one.
///
/// \p source_url appears in error messages and stack traces
/// (NULL -> empty string).
/// \p flags controls compilation behavior (NULL -> all defaults).
///
/// On success, *bytecode_out and *bytecode_size_out receive a newly
/// allocated buffer containing the serialized bytecode. Free it with
/// hermes_free_bytecode().
///
/// Returns napi_ok on success, napi_pending_exception on parse/compile
/// error (the exception describes the error).
napi_status hermes_compile_to_bytecode(
    napi_env env,
    const uint8_t *source,
    size_t source_size,
    const char *source_url,
    const hermes_compile_flags *flags,
    uint8_t **bytecode_out,
    size_t *bytecode_size_out);

/// Free bytecode allocated by hermes_compile_to_bytecode().
void hermes_free_bytecode(uint8_t *bytecode);

#endif // HERMES_NAPI_HERMES_NAPI_COMPILE_H
