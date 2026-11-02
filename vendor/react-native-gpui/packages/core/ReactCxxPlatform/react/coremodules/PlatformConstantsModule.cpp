/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "PlatformConstantsModule.h"

#include "GpuiJsEngine.h"

namespace facebook::react {

jsi::Object PlatformConstantsModule::getConstants(jsi::Runtime& rt) {
  const PlatformConstantsAndroid constants{
      .isTesting = false,
      .isDisableAnimations = false,
      .reactNativeVersion =
          {
              .major = 1000,
              .minor = 0,
              .patch = 0,
              .prerelease = std::nullopt,
          },
      .Version = 33, // Android 13 (API level 33)
      .Release = "",
      .Fingerprint = "",
      .Model = "",
      .ServerHost = "",
      .uiMode = "",
      .Brand = "",
      .Manufacturer = "",
  };
  auto result = bridging::toJs(rt, constants, jsInvoker_);

  // `Platform.constants.jsEngine`, reported by the active engine package. An
  // engine without a version still reports its name.
  const auto& engine = rngpui::activeJsEngine().info;
  auto jsEngine = jsi::Object(rt);
  jsEngine.setProperty(rt, "name", jsi::String::createFromUtf8(rt, engine.name));
  jsEngine.setProperty(
      rt, "version", jsi::String::createFromUtf8(rt, engine.version));
  result.setProperty(rt, "jsEngine", std::move(jsEngine));
  return result;
}

} // namespace facebook::react
