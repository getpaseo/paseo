/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

#include "llvh/ADT/Optional.h"
#include "llvh/ADT/StringRef.h"

#include <cstdint>
#include <string>

namespace facebook {
namespace hermes {

// Encoding types supported by TextDecoder. isSingleByteEncoding and
// kSingleByteEncodings depend on the default enum values.
enum class TextDecoderEncoding : uint8_t {
  UTF8,
  UTF16LE,
  UTF16BE,
  IBM866,
  ISO_8859_2,
  ISO_8859_3,
  ISO_8859_4,
  ISO_8859_5,
  ISO_8859_6,
  ISO_8859_7,
  ISO_8859_8,
  ISO_8859_8_I,
  ISO_8859_10,
  ISO_8859_13,
  ISO_8859_14,
  ISO_8859_15,
  ISO_8859_16,
  KOI8_R,
  KOI8_U,
  Macintosh,
  Windows874,
  Windows1250,
  Windows1251,
  Windows1252,
  Windows1253,
  Windows1254,
  Windows1255,
  Windows1256,
  Windows1257,
  Windows1258,
  XMacCyrillic,
  _count,
};

enum class DecodeError {
  None = 0,
  InvalidSequence, // Invalid byte sequence (fatal mode)
  InvalidSurrogate, // Invalid surrogate (fatal mode)
  OddByteCount, // Odd byte count in UTF-16 (fatal mode)
};

// First single-byte encoding value.
static constexpr uint8_t kFirstSingleByteEncoding =
    static_cast<uint8_t>(TextDecoderEncoding::IBM866);

// Number of single-byte encoding values
static constexpr uint8_t kNumSingleByteEncodings =
    (uint8_t)TextDecoderEncoding::_count - kFirstSingleByteEncoding;

inline bool isSingleByteEncoding(TextDecoderEncoding enc) {
  return static_cast<uint8_t>(enc) >= kFirstSingleByteEncoding;
}

// Array of pointers to single-byte encoding tables, indexed by
// (TextDecoderEncoding - kFirstSingleByteEncoding).
extern const std::array<const char16_t *, kNumSingleByteEncodings>
    kSingleByteEncodings;

// Parse the encoding label and return the corresponding encoding type.
// Returns llvh::None if the encoding is not supported.
llvh::Optional<TextDecoderEncoding> parseEncodingLabel(llvh::StringRef label);

// Get the canonical encoding name for the given encoding type.
const char *getEncodingName(TextDecoderEncoding encoding);

DecodeError decodeUTF8(
    const uint8_t *bytes,
    size_t length,
    bool fatal,
    bool ignoreBOM,
    bool stream,
    bool bomSeen,
    std::u16string *decoded,
    uint8_t outPendingBytes[4],
    size_t *outPendingCount,
    bool *outBOMSeen);

DecodeError decodeUTF16(
    const uint8_t *bytes,
    size_t length,
    bool fatal,
    bool ignoreBOM,
    bool bigEndian,
    bool stream,
    bool bomSeen,
    std::u16string *decoded,
    uint8_t outPendingBytes[4],
    size_t *outPendingCount,
    bool *outBOMSeen);

} // namespace hermes
} // namespace facebook
