package com.swmansion.enriched.markdown.spoiler

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.os.SystemClock
import com.swmansion.enriched.markdown.spans.SpoilerSpan
import com.swmansion.enriched.markdown.styles.SpoilerStyle

class SolidStrategy : SpoilerStrategy {
  private class SegmentState(
    var alpha: Float = 1f,
    var revealing: Boolean = false,
    var revealStartTime: Long = -1L,
    var revealFinished: Boolean = false,
    var revealCallback: (() -> Unit)? = null,
  )

  private val segments = mutableMapOf<SegmentKey, SegmentState>()
  private val solidPaint = Paint()
  private val rectF = RectF()

  private var color = 0
  private var borderRadius = 0f

  override fun applyStyle(style: SpoilerStyle) {
    this.color = style.color
    this.borderRadius = style.solidBorderRadius *
      android.content.res.Resources
        .getSystem()
        .displayMetrics.density
  }

  override fun drawSegment(
    canvas: Canvas,
    context: SpoilerDrawContext,
    key: SegmentKey,
    rect: SegmentRect,
  ) {
    val state = segments.getOrPut(key) { SegmentState() }

    if (state.revealing) {
      val now = SystemClock.uptimeMillis()
      if (state.revealStartTime < 0L) state.revealStartTime = now
      val progress = ((now - state.revealStartTime).toFloat() / REVEAL_DURATION_MS).coerceIn(0f, 1f)
      state.alpha = (1f - progress) * (1f - progress)
      if (progress >= 1f && !state.revealFinished) {
        state.revealFinished = true
        state.revealCallback?.invoke()
        state.revealCallback = null
      }
    }

    if (!state.revealFinished) {
      solidPaint.color = colorWithAlpha(this.color, state.alpha)
      rectF.set(rect.left, rect.top, rect.left + rect.width, rect.top + rect.height)
      canvas.drawRoundRect(rectF, borderRadius, borderRadius, solidPaint)
    }

    if (state.revealing && !state.revealFinished) {
      context.textView.postInvalidateOnAnimation()
    }
  }

  override fun pruneStaleSegments(activeKeys: Set<SegmentKey>) {
    val staleKeys = segments.keys - activeKeys
    for (key in staleKeys) {
      segments.remove(key)
    }
  }

  override fun revealSpan(
    span: SpoilerSpan,
    context: SpoilerDrawContext,
    onAllComplete: () -> Unit,
  ) {
    revealSegments(
      span = span,
      segmentKeys = segments.keys,
      onAllComplete = onAllComplete,
      cleanup = { keys -> keys.forEach { segments.remove(it) } },
      onSegment = { key, onComplete ->
        segments[key]?.let { state ->
          state.revealing = true
          state.revealCallback = onComplete
        }
      },
    )
    context.textView.invalidate()
  }

  override fun stop() {
    segments.clear()
  }
}
