/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

#include "Intrinsics.h"

#include "jsi/jsi.h"
#include "llvh/ADT/Optional.h"

#include <cstdint>
#include <limits>
#include <string>
#include <type_traits>

namespace facebook {
namespace hermes {

/// Result of getTypedArrayBuffer - the destination buffer info.
struct TypedArrayBufferInfo {
  uint8_t *data;
  size_t byteLength;
};

/// MutableBuffer implementation that owns a std::string of UTF-8 data.
class UTF8Buffer : public jsi::MutableBuffer {
 public:
  explicit UTF8Buffer(std::string &&data) : data_(std::move(data)) {}

  size_t size() const override {
    return data_.size();
  }

  uint8_t *data() override {
    return reinterpret_cast<uint8_t *>(data_.data());
  }

 private:
  std::string data_;
};

/// Try to convert a jsi::Value to a valid unsigned integer of type T.
/// Returns llvh::None if the value is not a number, is NaN, negative,
/// not an integer, exceeds MAX_SAFE_INTEGER, or exceeds the range of T.
template <typename T>
inline llvh::Optional<T> valueToUnsigned(const jsi::Value &val) {
  static_assert(std::is_unsigned<T>::value, "T must be an unsigned type");
  if (!val.isNumber()) {
    return llvh::None;
  }
  double d = val.asNumber();
  // Check non-negative and within MAX_SAFE_INTEGER (2^53 - 1), which is exactly
  // representable as a double. This ensures d could be an exact integer.
  constexpr double maxSafeInteger = 9007199254740991.0; // 2^53 - 1
  if (!(d >= 0 && d <= maxSafeInteger)) {
    return llvh::None;
  }
  // Cast to uint64_t and verify no fractional part was lost.
  auto u = static_cast<uint64_t>(d);
  if (static_cast<double>(u) != d) {
    return llvh::None;
  }
  if (u > std::numeric_limits<T>::max()) {
    return llvh::None;
  }
  return static_cast<T>(u);
}

/// Extract buffer info from a TypedArray-like object.
/// We use duck-typing (checking for buffer/byteOffset/byteLength) rather than
/// instanceof Uint8Array. This is more permissive than the spec requires, but
/// handles cross-realm Uint8Arrays and is consistent with JSI's portable
/// design. The original VM implementation used internal type checks.
/// Throws JSError if the object is not a valid TypedArray or is detached.
/// \param errorMessage The error message to use if the object is invalid.
/// \param detachedErrorMessage The error message to use if the buffer is
///   detached.
TypedArrayBufferInfo getTypedArrayBuffer(
    jsi::Runtime &rt,
    const jsi::Value &val,
    const char *errorMessage,
    const char *detachedErrorMessage);

} // namespace hermes
} // namespace facebook
