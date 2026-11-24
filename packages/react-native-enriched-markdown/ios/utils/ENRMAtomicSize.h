#pragma once

#include <CoreGraphics/CGGeometry.h>
#include <atomic>
#include <cstdint>
#include <cstring>

/**
 * Lock-free size mailbox (issue #550).
 *
 * `measureContent` may run on the JS/layout thread while React Native holds
 * the ShadowTree revision mutex (`preventShadowTreeCommitExhaustion` re-runs
 * the entire commit — layout included — under `revisionMutexRecursive_` after
 * three failed optimistic commits). A main-thread committer (e.g. Reanimated)
 * can already be blocked on that same mutex, so any `dispatch_sync` to main
 * from the measure path can deadlock: JS waits for main, main waits for the
 * mutex JS holds. iOS kills the frozen app ~60s later (watchdog 0x8BADF00D).
 *
 * Reading `view.bounds` from a background thread is not safe either, so the
 * component view *publishes* its last committed size here (from
 * `updateLayoutMetrics:`, always on main) and the measure path *loads* it
 * wait-free from any thread.
 *
 * Both dimensions are packed as IEEE-754 floats into one `uint64_t` so a
 * single lock-free atomic covers the pair — a reader can never observe a new
 * width with an old height (no torn reads). Relaxed memory ordering suffices:
 * the value is self-contained and no other memory is published through it.
 */
class ENRMAtomicSize {
public:
  void store(CGSize size)
  {
    bits_.store(pack(size), std::memory_order_relaxed);
  }

  CGSize load() const
  {
    return unpack(bits_.load(std::memory_order_relaxed));
  }

private:
  static uint64_t pack(CGSize size)
  {
    float width = (float)size.width;
    float height = (float)size.height;
    uint32_t widthBits;
    uint32_t heightBits;
    memcpy(&widthBits, &width, sizeof(widthBits));
    memcpy(&heightBits, &height, sizeof(heightBits));
    return ((uint64_t)widthBits << 32) | heightBits;
  }

  static CGSize unpack(uint64_t bits)
  {
    uint32_t widthBits = (uint32_t)(bits >> 32);
    uint32_t heightBits = (uint32_t)bits;
    float width;
    float height;
    memcpy(&width, &widthBits, sizeof(width));
    memcpy(&height, &heightBits, sizeof(height));
    return CGSizeMake(width, height);
  }

  std::atomic<uint64_t> bits_{0};
};
