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
std::atomic<double> screenWidth{0.0};
std::atomic<double> screenHeight{0.0};
std::atomic<double> textScale{1.0};
} // namespace

bool DeviceInfoModule::setWindowMetrics(double width, double height, double scale) {
  const auto validScale = scale > 0.0 ? scale : 1.0;
  const auto oldWidth = windowWidth.exchange(width, std::memory_order_relaxed);
  const auto oldHeight = windowHeight.exchange(height, std::memory_order_relaxed);
  const auto oldScale = displayScale.exchange(validScale, std::memory_order_relaxed);
  return oldWidth != width || oldHeight != height || oldScale != validScale;
}

bool DeviceInfoModule::setDisplayMetrics(double width, double height, double fontScale) {
  const auto validFontScale = fontScale > 0.0 ? fontScale : 1.0;
  const auto oldWidth = screenWidth.exchange(width, std::memory_order_relaxed);
  const auto oldHeight = screenHeight.exchange(height, std::memory_order_relaxed);
  const auto oldFontScale = textScale.exchange(validFontScale, std::memory_order_relaxed);
  return oldWidth != width || oldHeight != height || oldFontScale != validFontScale;
}

double DeviceInfoModule::fontScale() {
  return textScale.load(std::memory_order_relaxed);
}

Size DeviceInfoModule::screenSize() {
  const auto width = screenWidth.load(std::memory_order_relaxed);
  const auto height = screenHeight.load(std::memory_order_relaxed);
  if (width <= 0.0 || height <= 0.0) {
    return windowSize();
  }
  return Size{.width = static_cast<Float>(width), .height = static_cast<Float>(height)};
}

double DeviceInfoModule::scale() {
  return displayScale.load(std::memory_order_relaxed);
}

Size DeviceInfoModule::windowSize() {
  return Size{
      .width = static_cast<Float>(windowWidth.load(std::memory_order_relaxed)),
      .height = static_cast<Float>(windowHeight.load(std::memory_order_relaxed)),
  };
}

DeviceInfoConstants DeviceInfoModule::getConstants(jsi::Runtime& /*rt*/) {
  const auto scale = displayScale.load(std::memory_order_relaxed);
  const auto fontScale = textScale.load(std::memory_order_relaxed);
  const auto screen = screenSize();
  return DeviceInfoConstants{
      .Dimensions =
          {.window =
               DisplayMetrics{
                   windowWidth.load(std::memory_order_relaxed),
                   windowHeight.load(std::memory_order_relaxed),
                   scale,
                   fontScale,
               },
           .screen =
               DisplayMetrics{
                   static_cast<double>(screen.width),
                   static_cast<double>(screen.height),
                   scale,
                   fontScale,
               }},
  };
}

} // namespace facebook::react
