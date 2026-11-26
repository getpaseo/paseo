package com.swmansion.enriched.markdown.spoiler

import android.graphics.Canvas
import android.graphics.Paint
import com.swmansion.enriched.markdown.spans.SpoilerSpan
import com.swmansion.enriched.markdown.styles.SpoilerStyle

class ParticleStrategy(
  private val animator: SpoilerAnimator,
) : SpoilerStrategy {
  private val segments = mutableMapOf<SegmentKey, SpoilerParticleDrawable>()
  private val backgroundPaint = Paint()

  private var particleColor = 0
  private var particleDensity = 0f
  private var particleSpeed = 0f

  override fun applyStyle(style: SpoilerStyle) {
    this.particleColor = style.color
    this.particleDensity = style.particleDensity
    this.particleSpeed = style.particleSpeed
  }

  override fun drawSegment(
    canvas: Canvas,
    context: SpoilerDrawContext,
    key: SegmentKey,
    rect: SegmentRect,
  ) {
    val drawable =
      segments.getOrPut(key) {
        SpoilerParticleDrawable(particleColor, particleDensity, particleSpeed)
          .also { animator.register(it) }
      }
    drawable.setSize(rect.width, rect.height)

    backgroundPaint.color = colorWithAlpha(context.backgroundColor, drawable.overallAlpha)
    canvas.drawRect(rect.left, rect.top, rect.left + rect.width, rect.top + rect.height, backgroundPaint)
    drawable.draw(canvas, rect.left, rect.top)
  }

  override fun pruneStaleSegments(activeKeys: Set<SegmentKey>) {
    val staleKeys = segments.keys - activeKeys
    for (key in staleKeys) {
      segments.remove(key)?.let { animator.unregister(it) }
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
      cleanup = { keys -> keys.forEach { segments.remove(it)?.let { d -> animator.unregister(d) } } },
      onSegment = { key, onComplete -> segments[key]?.startReveal(onComplete) },
    )
    animator.ensureRunning()
  }

  override fun stop() {
    segments.values.forEach { animator.unregister(it) }
    segments.clear()
  }
}
