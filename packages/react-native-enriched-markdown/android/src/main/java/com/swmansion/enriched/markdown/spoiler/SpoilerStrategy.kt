package com.swmansion.enriched.markdown.spoiler

import android.graphics.Canvas
import com.swmansion.enriched.markdown.spans.SpoilerSpan
import com.swmansion.enriched.markdown.styles.SpoilerStyle

interface SpoilerStrategy {
  fun applyStyle(style: SpoilerStyle)

  fun drawSegment(
    canvas: Canvas,
    context: SpoilerDrawContext,
    key: SegmentKey,
    rect: SegmentRect,
  )

  fun pruneStaleSegments(activeKeys: Set<SegmentKey>)

  fun revealSpan(
    span: SpoilerSpan,
    context: SpoilerDrawContext,
    onAllComplete: () -> Unit,
  )

  fun stop()
}

fun revealSegments(
  span: SpoilerSpan,
  segmentKeys: Set<SegmentKey>,
  onAllComplete: () -> Unit,
  cleanup: (List<SegmentKey>) -> Unit,
  onSegment: (SegmentKey, onSegmentComplete: () -> Unit) -> Unit,
) {
  val spanIdentity = System.identityHashCode(span)
  val keys = segmentKeys.filter { it.spanIdentity == spanIdentity }

  if (keys.isEmpty()) {
    onAllComplete()
    return
  }

  val remaining = intArrayOf(keys.size)
  for (key in keys) {
    onSegment(key) {
      remaining[0]--
      if (remaining[0] <= 0) {
        cleanup(keys)
        onAllComplete()
      }
    }
  }
}
