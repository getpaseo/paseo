/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "DeviceInfoModule.h"

#include <atomic>

namespace facebook::react {

namespace {
std::atomic<double> windowWidth{1280.0};
std::atomic<double> windowHeight{720.0};
std::atomic<double> displayScale{1.0};
} // namespace

bool DeviceInfoModule::setWindowMetrics(double width, double height, double scale) {
  const auto validScale = scale > 0.0 ? scale : 1.0;
  const auto oldWidth = windowWidth.exchange(width, std::memory_order_relaxed);
  const auto oldHeight = windowHeight.exchange(height, std::memory_order_relaxed);
  const auto oldScale = displayScale.exchange(validScale, std::memory_order_relaxed);
  return oldWidth != width || oldHeight != height || oldScale != validScale;
}

Size DeviceInfoModule::windowSize() {
  return Size{
      .width = static_cast<Float>(windowWidth.load(std::memory_order_relaxed)),
      .height = static_cast<Float>(windowHeight.load(std::memory_order_relaxed)),
  };
}

DeviceInfoConstants DeviceInfoModule::getConstants(jsi::Runtime& /*rt*/) {
  const auto scale = displayScale.load(std::memory_order_relaxed);
  return DeviceInfoConstants{
      .Dimensions =
          {.window =
               DisplayMetrics{
                   windowWidth.load(std::memory_order_relaxed),
                   windowHeight.load(std::memory_order_relaxed),
                   scale,
                   1.0,
               }},
  };
}

} // namespace facebook::react
