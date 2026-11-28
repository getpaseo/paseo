/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "AppStateModule.h"

#include <mutex>

namespace facebook::react {

namespace {
std::mutex stateMutex;
std::string currentState = "active";
} // namespace

void AppStateModule::setState(const std::string& state) {
  std::lock_guard<std::mutex> lock(stateMutex);
  currentState = state;
}

std::string AppStateModule::state() {
  std::lock_guard<std::mutex> lock(stateMutex);
  return currentState;
}

AppStateConstants AppStateModule::getConstants(jsi::Runtime& /*rt*/) {
  return AppStateConstants{.initialAppState = state()};
}

void AppStateModule::getCurrentAppState(
    jsi::Runtime& /*rt*/,
    const AsyncCallback<AppState>& success,
    jsi::Function /*error*/) {
  success(AppState{state()});
}

void AppStateModule::addListener(
    jsi::Runtime& /*rt*/,
    const std::string& /*eventName*/) {}

void AppStateModule::removeListeners(jsi::Runtime& /*rt*/, double /*count*/) {}

} // namespace facebook::react
