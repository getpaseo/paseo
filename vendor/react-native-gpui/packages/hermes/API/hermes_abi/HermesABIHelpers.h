/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#ifndef HERMES_ABI_HERMES_ABI_HELPERS_H
#define HERMES_ABI_HERMES_ABI_HELPERS_H

#include "hermes_abi/hermes_abi.h"

namespace facebook {
namespace hermes {
namespace abi {

#define DECLARE_HERMES_ABI_POINTER_HELPERS(name)                          \
  inline HermesABI##name create##name(HermesABIManagedPointer *ptr) {     \
    return {ptr};                                                         \
  }                                                                       \
  inline HermesABI##name##OrError create##name##OrError(                  \
      HermesABIManagedPointer *ptr) {                                     \
    return {(uintptr_t)ptr};                                              \
  }                                                                       \
  inline HermesABI##name##OrError create##name##OrError(                  \
      HermesABIErrorCode err) {                                           \
    return {static_cast<uintptr_t>((err << 2) | 1)};                      \
  }                                                                       \
  inline bool isError(const HermesABI##name##OrError &p) {                \
    return p.ptr_or_error & 1;                                            \
  }                                                                       \
  inline HermesABIErrorCode getError(const HermesABI##name##OrError &p) { \
    assert(isError(p));                                                   \
    return (HermesABIErrorCode)(p.ptr_or_error >> 2);                     \
  }                                                                       \
  inline HermesABI##name get##name(HermesABI##name##OrError p) {          \
    assert(!isError(p));                                                  \
    return create##name((HermesABIManagedPointer *)p.ptr_or_error);       \
  }
HERMES_ABI_POINTER_TYPES(DECLARE_HERMES_ABI_POINTER_HELPERS)
#undef DECLARE_HERMES_ABI_POINTER_HELPERS

/// Release the given HermesABIManagedPointer.
inline void releasePointer(HermesABIManagedPointer *mp) {
  mp->vtable->invalidate(mp);
}

inline HermesABIVoidOrError createVoidOrError(void) {
  return {0};
}
inline HermesABIVoidOrError createVoidOrError(HermesABIErrorCode err) {
  return {(uintptr_t)((err << 2) | 1)};
}
inline bool isError(const HermesABIVoidOrError &v) {
  return v.void_or_error & 1;
}
inline HermesABIErrorCode getError(const HermesABIVoidOrError &v) {
  assert(isError(v));
  return (HermesABIErrorCode)(v.void_or_error >> 2);
}

inline HermesABIBoolOrError createBoolOrError(bool val) {
  return {(uintptr_t)((val ? 1 : 0) << 2)};
}
inline HermesABIBoolOrError createBoolOrError(HermesABIErrorCode err) {
  return {(uintptr_t)((err << 2) | 1)};
}
inline bool isError(const HermesABIBoolOrError &p) {
  return p.bool_or_error & 1;
}
inline HermesABIErrorCode getError(const HermesABIBoolOrError &p) {
  return (HermesABIErrorCode)(p.bool_or_error >> 2);
}
inline bool getBool(const HermesABIBoolOrError &p) {
  return p.bool_or_error >> 2;
}

inline HermesABIUint8PtrOrError createUint8PtrOrError(uint8_t *val) {
  HermesABIUint8PtrOrError res;
  res.is_error = false;
  res.data.val = val;
  return res;
}
inline HermesABIUint8PtrOrError createUint8PtrOrError(HermesABIErrorCode err) {
  HermesABIUint8PtrOrError res;
  res.is_error = true;
  res.data.error = err;
  return res;
}
inline bool isError(const HermesABIUint8PtrOrError &p) {
  return p.is_error;
}
inline HermesABIErrorCode getError(const HermesABIUint8PtrOrError &p) {
  return (HermesABIErrorCode)p.data.error;
}
inline uint8_t *getUint8Ptr(const HermesABIUint8PtrOrError &p) {
  return p.data.val;
}

inline HermesABISizeTOrError createSizeTOrError(size_t val) {
  HermesABISizeTOrError res;
  res.is_error = false;
  res.data.val = val;
  return res;
}
inline HermesABISizeTOrError createSizeTOrError(HermesABIErrorCode err) {
  HermesABISizeTOrError res;
  res.is_error = true;
  res.data.error = err;
  return res;
}
inline bool isError(const HermesABISizeTOrError &p) {
  return p.is_error;
}
inline HermesABIErrorCode getError(const HermesABISizeTOrError &p) {
  return (HermesABIErrorCode)p.data.error;
}
inline size_t getSizeT(const HermesABISizeTOrError &p) {
  return p.data.val;
}

inline HermesABIPropNameIDListPtrOrError createPropNameIDListPtrOrError(
    HermesABIPropNameIDList *ptr) {
  return {(uintptr_t)ptr};
}
inline HermesABIPropNameIDListPtrOrError createPropNameIDListPtrOrError(
    HermesABIErrorCode err) {
  return {static_cast<uintptr_t>((err << 2) | 1)};
}
inline bool isError(HermesABIPropNameIDListPtrOrError p) {
  return p.ptr_or_error & 1;
}
inline HermesABIErrorCode getError(HermesABIPropNameIDListPtrOrError p) {
  assert(isError(p));
  return (HermesABIErrorCode)(p.ptr_or_error >> 2);
}
inline HermesABIPropNameIDList *getPropNameIDListPtr(
    HermesABIPropNameIDListPtrOrError p) {
  assert(!isError(p));
  return (HermesABIPropNameIDList *)p.ptr_or_error;
}

inline HermesABIValue createUndefinedValue() {
  HermesABIValue val;
  val.kind = HermesABIValueKindUndefined;
  return val;
}
inline HermesABIValue createNullValue() {
  HermesABIValue val;
  val.kind = HermesABIValueKindNull;
  return val;
}
inline HermesABIValue createBoolValue(bool b) {
  HermesABIValue val;
  val.kind = HermesABIValueKindBoolean;
  val.data.boolean = b;
  return val;
}
inline HermesABIValue createNumberValue(double d) {
  HermesABIValue val;
  val.kind = HermesABIValueKindNumber;
  val.data.number = d;
  return val;
}
inline HermesABIValue createObjectValue(HermesABIManagedPointer *ptr) {
  HermesABIValue val;
  val.kind = HermesABIValueKindObject;
  val.data.pointer = ptr;
  return val;
}
inline HermesABIValue createObjectValue(const HermesABIObject &obj) {
  return createObjectValue(obj.pointer);
}
inline HermesABIValue createStringValue(HermesABIManagedPointer *ptr) {
  HermesABIValue val;
  val.kind = HermesABIValueKindString;
  val.data.pointer = ptr;
  return val;
}
inline HermesABIValue createStringValue(const HermesABIString &str) {
  return createStringValue(str.pointer);
}
inline HermesABIValue createBigIntValue(HermesABIManagedPointer *ptr) {
  HermesABIValue val;
  val.kind = HermesABIValueKindBigInt;
  val.data.pointer = ptr;
  return val;
}
inline HermesABIValue createBigIntValue(const HermesABIBigInt &bi) {
  return createBigIntValue(bi.pointer);
}
inline HermesABIValue createSymbolValue(HermesABIManagedPointer *ptr) {
  HermesABIValue val;
  val.kind = HermesABIValueKindSymbol;
  val.data.pointer = ptr;
  return val;
}
inline HermesABIValue createSymbolValue(const HermesABISymbol &sym) {
  return createSymbolValue(sym.pointer);
}

inline HermesABIValueKind getValueKind(const HermesABIValue &val) {
  return val.kind;
}

inline bool isUndefinedValue(const HermesABIValue &val) {
  return getValueKind(val) == HermesABIValueKindUndefined;
}
inline bool isNullValue(const HermesABIValue &val) {
  return getValueKind(val) == HermesABIValueKindNull;
}
inline bool isBoolValue(const HermesABIValue &val) {
  return getValueKind(val) == HermesABIValueKindBoolean;
}
inline bool isNumberValue(const HermesABIValue &val) {
  return getValueKind(val) == HermesABIValueKindNumber;
}
inline bool isObjectValue(const HermesABIValue &val) {
  return getValueKind(val) == HermesABIValueKindObject;
}
inline bool isStringValue(const HermesABIValue &val) {
  return getValueKind(val) == HermesABIValueKindString;
}
inline bool isBigIntValue(const HermesABIValue &val) {
  return getValueKind(val) == HermesABIValueKindBigInt;
}
inline bool isSymbolValue(const HermesABIValue &val) {
  return getValueKind(val) == HermesABIValueKindSymbol;
}

inline bool getBoolValue(const HermesABIValue &val) {
  assert(isBoolValue(val));
  return val.data.boolean;
}
inline double getNumberValue(const HermesABIValue &val) {
  assert(isNumberValue(val));
  return val.data.number;
}
inline HermesABIObject getObjectValue(const HermesABIValue &val) {
  assert(isObjectValue(val));
  return createObject(val.data.pointer);
}
inline HermesABIString getStringValue(const HermesABIValue &val) {
  assert(isStringValue(val));
  return createString(val.data.pointer);
}
inline HermesABIBigInt getBigIntValue(const HermesABIValue &val) {
  assert(isBigIntValue(val));
  return createBigInt(val.data.pointer);
}
inline HermesABISymbol getSymbolValue(const HermesABIValue &val) {
  assert(isSymbolValue(val));
  return createSymbol(val.data.pointer);
}
inline HermesABIManagedPointer *getPointerValue(const HermesABIValue &val) {
  assert(getValueKind(val) & HERMES_ABI_POINTER_MASK);
  return val.data.pointer;
}

/// Release any underlying resources associated with the HermesABIValue.
inline void releaseValue(const HermesABIValue &val) {
  if (getValueKind(val) & HERMES_ABI_POINTER_MASK)
    releasePointer(getPointerValue(val));
}

/// Create a HermesABIValueOrError from a HermesABIValue or an error code.
inline HermesABIValueOrError createValueOrError(HermesABIValue val) {
  HermesABIValueOrError res;
  res.value = val;
  return res;
}
inline HermesABIValueOrError createValueOrError(HermesABIErrorCode err) {
  HermesABIValueOrError res;
  res.value.kind = HermesABIValueKindError;
  res.value.data.error = err;
  return res;
}

inline bool isError(const HermesABIValueOrError &val) {
  return getValueKind(val.value) == HermesABIValueKindError;
}
inline HermesABIValue getValue(const HermesABIValueOrError &val) {
  assert(!isError(val));
  return val.value;
}
inline HermesABIErrorCode getError(const HermesABIValueOrError &val) {
  assert(isError(val));
  return val.value.data.error;
}

} // namespace abi
} // namespace hermes
} // namespace facebook

#endif // HERMES_ABI_HERMES_ABI_HELPERS_H
