/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "PlatformTimerRegistryImpl.h"

#include <glog/logging.h>
#include <algorithm>
#include <chrono>

namespace facebook::react {

std::mutex PlatformTimerRegistryImpl::registriesMutex_;
std::unordered_set<PlatformTimerRegistryImpl*> PlatformTimerRegistryImpl::registries_;

PlatformTimerRegistryImpl::PlatformTimerRegistryImpl() noexcept {
  std::lock_guard<std::mutex> guard(registriesMutex_);
  registries_.insert(this);
}

PlatformTimerRegistryImpl::~PlatformTimerRegistryImpl() noexcept {
  quit();
  std::lock_guard<std::mutex> guard(registriesMutex_);
  registries_.erase(this);
}

uint64_t PlatformTimerRegistryImpl::pendingDueWithin(uint64_t windowMs) noexcept {
  const auto limit = std::chrono::steady_clock::now() +
      std::chrono::milliseconds(windowMs);
  std::lock_guard<std::mutex> registriesGuard(
      PlatformTimerRegistryImpl::registriesMutex_);
  uint64_t count = 0;
  for (auto* registry : PlatformTimerRegistryImpl::registries_) {
    std::lock_guard<std::mutex> timersGuard(registry->timersMutex_);
    for (const auto& [id, timer] : registry->timers_) {
      (void)id;
      if (!timer.isRecurring && timer.due <= limit) ++count;
    }
  }
  return count;
}

extern "C" uint64_t rn_gpui_pending_timers_due_within(
    uint64_t windowMs) noexcept {
  return PlatformTimerRegistryImpl::pendingDueWithin(windowMs);
}

void PlatformTimerRegistryImpl::quit() {
  LOG(INFO) << "Shutting down PlatformTimerRegistryImpl...";
  taskDispatchThread_.quit();
  std::lock_guard<std::mutex> guard(timersMutex_);
  timers_.clear();
}

void PlatformTimerRegistryImpl::createTimer(uint32_t timerId, double delayMs) {
  createTimerInternal(timerId, delayMs, false);
}

void PlatformTimerRegistryImpl::deleteTimer(uint32_t timerId) {
  std::lock_guard<std::mutex> guard(timersMutex_);
  if (auto it = timers_.find(timerId); it != timers_.end()) {
    timers_.erase(it);
  }
}

void PlatformTimerRegistryImpl::createRecurringTimer(
    uint32_t timerId,
    double delayMs) {
  createTimerInternal(timerId, delayMs, true);
}

void PlatformTimerRegistryImpl::createTimerInternal(
    uint32_t timerId,
    double delayMs,
    bool recurring) {
  {
    std::lock_guard<std::mutex> guard(timersMutex_);
    timers_.emplace(
        timerId,
        Timer{
            .timerId = timerId,
            .durationMs = delayMs,
            .isRecurring = recurring});
  }
  startTimer(timerId, delayMs);
}

void PlatformTimerRegistryImpl::startTimer(uint32_t timerId, double delayMs) {
  // RN's generic TimerManager currently implements requestAnimationFrame as
  // setTimeout(0). Re-arming that timer with a zero delay spins this worker and
  // floods the JS runtime (observed at >70k Animated.Value updates/second),
  // starving input and making transforms visibly janky. Pace sub-frame timers
  // at 60 Hz; JS still receives the normal timer callback, but at a useful
  // desktop frame cadence instead of an unbounded tight loop.
  constexpr double kMinimumFrameTimerMs = 1000.0 / 60.0;
  const auto scheduledDelayMs = std::max(delayMs, kMinimumFrameTimerMs);
  {
    std::lock_guard<std::mutex> guard(timersMutex_);
    if (auto it = timers_.find(timerId); it != timers_.end()) {
      it->second.due = std::chrono::steady_clock::now() +
          std::chrono::milliseconds(static_cast<int32_t>(scheduledDelayMs));
    } else {
      return;
    }
  }
  taskDispatchThread_.runAsync(
      [this, timerId, delayMs]() {
        bool isRecurring = true;
        {
          std::lock_guard<std::mutex> guard(timersMutex_);
          auto it = timers_.find(timerId);
          if (it == timers_.end()) {
            // timer was deleted before it could have been dispatched (at this
            // iteration)
            return;
          }
          if (!it->second.isRecurring) {
            timers_.erase(it);
            isRecurring = false;
          }
        }

        if (auto timerManagerStrong = timerManager_.lock()) {
          timerManagerStrong->callTimer(timerId);
        }

        if (isRecurring) {
          startTimer(timerId, delayMs);
        }
      },
      std::chrono::milliseconds(static_cast<int32_t>(scheduledDelayMs)));
}

void PlatformTimerRegistryImpl::setTimerManager(
    std::weak_ptr<TimerManager> timerManager) {
  timerManager_ = timerManager;
}

} // namespace facebook::react
