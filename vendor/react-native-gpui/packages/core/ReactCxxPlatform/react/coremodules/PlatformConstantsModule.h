/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

#include <FBReactNativeSpec/FBReactNativeSpecJSI.h>
#include <jsi/jsi.h>
#include <optional>

namespace facebook::react {

using ReactNativeVersionAndroid =
    NativePlatformConstantsAndroidReactNativeVersionAndroid<int, int, int, std::optional<int>>;

template <>
struct Bridging<ReactNativeVersionAndroid>
    : NativePlatformConstantsAndroidReactNativeVersionAndroidBridging<ReactNativeVersionAndroid> {};

using PlatformConstantsAndroid = NativePlatformConstantsAndroidPlatformConstantsAndroid<
    bool,
    std::optional<bool>,
    ReactNativeVersionAndroid,
    int,
    std::string,
    std::string,
    std::string,
    std::string,
    std::optional<std::string>,
    std::string,
    std::string,
    std::string>;

template <>
struct Bridging<PlatformConstantsAndroid>
    : NativePlatformConstantsAndroidPlatformConstantsAndroidBridging<PlatformConstantsAndroid> {};

// T159303412: [RN] Metro: Need support for new target platform
class PlatformConstantsModule : public NativePlatformConstantsAndroidCxxSpec<PlatformConstantsModule> {
 public:
  explicit PlatformConstantsModule(std::shared_ptr<CallInvoker> jsInvoker)
      : NativePlatformConstantsAndroidCxxSpec(jsInvoker)
  {
  }

  std::string getAndroidID(jsi::Runtime & /*rt*/)
  {
    return "";
  }

  // Returns the generated constants plus a `jsEngine: { name, version }` field
  // reported by the active engine package. The generated Android constants
  // struct cannot carry the extra field, so the object is built here.
  jsi::Object getConstants(jsi::Runtime &rt);
};

} // namespace facebook::react
