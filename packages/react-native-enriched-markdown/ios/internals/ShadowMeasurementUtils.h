#pragma once

#include "MeasurementCache.h"
#import <Foundation/Foundation.h>
#import <React/RCTUtils.h>
#include <algorithm>
#include <cmath>
#include <react/renderer/core/LayoutConstraints.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/utils/ManagedObjectWrapper.h>

namespace facebook::react {

// Threading contract (issue #550): measureContent may run on any thread while
// RN holds commit locks that main-thread committers (e.g. Reanimated) also
// acquire — with `preventShadowTreeCommitExhaustion`, the JS thread re-runs
// layout under `revisionMutexRecursive_` after 3 failed optimistic commits.
// Any dispatch_sync to main from this path can therefore deadlock: JS waits
// for main, main waits for the mutex JS holds (watchdog kill 0x8BADF00D).
// Nothing in the measurement path may wait on the main thread.
// EnrichedMarkdownText and EnrichedMarkdown both measure view-free
// (ENRMViewFreeMeasurement.h) and comply fully. The one known remaining
// violation is the text input's own measureContent
// (EnrichedMarkdownTextInputShadowNode.mm), which measures live editable
// UITextView state and needs its own strategy.

/**
 * Font scale (Dynamic Type multiplier) for measurement, without touching the
 * main thread.
 *
 * Reads `LayoutContext::fontSizeMultiplier` instead of calling
 * `RCTFontSizeMultiplier()` (a UIKit read that previously forced a
 * dispatch_sync to main on every measure — a deadlock window under the locked
 * commit fallback, see the contract above). RN maintains the multiplier for
 * us: `RCTFabricSurface::_updateLayoutContext` sets it on main from
 * `RCTFontSizeMultiplier()` and re-runs `constraintLayout` whenever
 * `UIContentSizeCategoryDidChangeNotification` fires, so every Dynamic Type
 * change re-measures with the fresh value. This is the same source
 * `ParagraphShadowNode` uses for core text. A measure racing a Dynamic Type
 * change at worst caches under the outgoing scale, which is never read again
 * once the re-layout lands.
 */
static inline CGFloat ENRMFontScaleForMeasurement(bool allowFontScaling, const LayoutContext &layoutContext)
{
  return allowFontScaling ? layoutContext.fontSizeMultiplier : 1.0;
}

static inline Size ENRMClampMeasuredSize(CGSize size, const LayoutConstraints &layoutConstraints)
{
  Float clampedWidth = std::max((Float)size.width, layoutConstraints.minimumSize.width);
  clampedWidth = std::min(clampedWidth, layoutConstraints.maximumSize.width);
  Float clampedHeight = std::max((Float)size.height, layoutConstraints.minimumSize.height);
  if (std::isfinite(layoutConstraints.maximumSize.height)) {
    clampedHeight = std::min(clampedHeight, layoutConstraints.maximumSize.height);
  }
  return {clampedWidth, clampedHeight};
}

template <typename PropsT>
static inline bool ENRMPropsNeedExactStreamingMeasurement(const PropsT &oldProps, const PropsT &newProps)
{
  return oldProps.streamingAnimation != newProps.streamingAnimation ||
         oldProps.allowFontScaling != newProps.allowFontScaling ||
         oldProps.maxFontSizeMultiplier != newProps.maxFontSizeMultiplier ||
         oldProps.allowTrailingMargin != newProps.allowTrailingMargin ||
         oldProps.md4cFlags.underline != newProps.md4cFlags.underline ||
         oldProps.md4cFlags.superscript != newProps.md4cFlags.superscript ||
         oldProps.md4cFlags.subscript != newProps.md4cFlags.subscript ||
         oldProps.md4cFlags.latexMath != newProps.md4cFlags.latexMath ||
         oldProps.md4cFlags.highlight != newProps.md4cFlags.highlight ||
         oldProps.md4cFlags.hardSoftBreaks != newProps.md4cFlags.hardSoftBreaks ||
         oldProps.md4cFlags.preserveBlankLines != newProps.md4cFlags.preserveBlankLines ||
         oldProps.isGFM != newProps.isGFM || oldProps.md4cFlags.admonitions != newProps.md4cFlags.admonitions ||
         computeStyleFingerprint(oldProps.markdownStyle) != computeStyleFingerprint(newProps.markdownStyle);
}

/**
 * Shared measureContent implementation for the markdown component views.
 *
 * Owns the thread-safe layers — the streaming fast path (lock-free
 * `ENRMAtomicSize` mailbox published by `updateLayoutMetrics:`), the
 * LRU measurement cache, and the `layoutContext`-sourced font scale — then
 * delegates cache misses to `measureUncached`, through which both components
 * plug their view-free pipeline (`ENRMMeasureMarkdownViewFree` /
 * `ENRMMeasureSegmentedMarkdownViewFree`); the resolved view is still handed
 * to the block for strategies that can use it. `fontScale` handed to the
 * block is the real multiplier even when streaming skips the cache —
 * rendering must always use it.
 */
template <typename PropsT, typename ViewT>
static inline Size
ENRMMeasureMarkdownContent(const PropsT &typedProps, const std::shared_ptr<void> &componentViewRef, int receivedCounter,
                           int &lastExactMeasurementCounter, CGSize &lastExactMeasurementSize, MarkdownFlavor flavor,
                           const LayoutContext &layoutContext, const LayoutConstraints &layoutConstraints,
                           CGSize (^measureUncached)(ViewT *view, CGFloat maxWidth, CGFloat fontScale))
{
  CGFloat maxWidth = layoutConstraints.maximumSize.width;

  RCTInternalGenericWeakWrapper *weakWrapper = (RCTInternalGenericWeakWrapper *)unwrapManagedObject(componentViewRef);
  ViewT *view = weakWrapper ? (ViewT *)weakWrapper.object : nil;

  // Streaming fast path. Yoga re-measures several times per pass; the first call
  // bumps lastExactMeasurementCounter, the rest land here. Return the freshly
  // measured size, not the view's mailbox — mid-pass the frame isn't committed,
  // so the mailbox is a generation stale and would freeze the height.
  if (typedProps.streamingAnimation && view && receivedCounter <= lastExactMeasurementCounter) {
    if (lastExactMeasurementSize.width > 0 && lastExactMeasurementSize.height > 0) {
      return ENRMClampMeasuredSize(lastExactMeasurementSize, layoutConstraints);
    }
    CGSize currentSize = [view lastCommittedLayoutSize];
    if (currentSize.width > 0 && currentSize.height > 0) {
      return ENRMClampMeasuredSize(currentSize, layoutConstraints);
    }
  }

  const bool shouldUseMeasurementCache = !typedProps.streamingAnimation;
  CGFloat fontScale = ENRMFontScaleForMeasurement(typedProps.allowFontScaling, layoutContext);

  if (shouldUseMeasurementCache && !typedProps.markdown.empty()) {
    auto cacheKey = buildMeasurementCacheKey(typedProps, maxWidth, fontScale, flavor);
    CachedSize cached;
    if (MeasurementCache::shared().get(cacheKey, cached)) {
      return ENRMClampMeasuredSize(CGSizeMake(cached.width, cached.height), layoutConstraints);
    }
  }

  CGSize size = measureUncached(view, maxWidth, fontScale);

  if (shouldUseMeasurementCache && !typedProps.markdown.empty()) {
    auto cacheKey = buildMeasurementCacheKey(typedProps, maxWidth, fontScale, flavor);
    MeasurementCache::shared().set(cacheKey, {size.width, size.height});
  }

  if (typedProps.streamingAnimation) {
    lastExactMeasurementCounter = receivedCounter;
    lastExactMeasurementSize = size;
  }

  return ENRMClampMeasuredSize(size, layoutConstraints);
}

} // namespace facebook::react
