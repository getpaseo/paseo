package com.swmansion.enriched.markdown.utils.text

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.text.Spannable
import android.view.animation.LinearInterpolator
import android.widget.TextView
import com.swmansion.enriched.markdown.spans.FadeInSpan
import com.swmansion.enriched.markdown.utils.common.isReducedMotionEnabled
import java.lang.ref.WeakReference

class TailFadeInAnimator(
  textView: TextView,
) {
  private val viewRef = WeakReference(textView)

  private val activeAnimations = mutableMapOf<FadeInSpan, ValueAnimator>()

  fun animate(
    tailStart: Int,
    tailEnd: Int,
  ) {
    if (tailEnd <= tailStart) return

    val textView = viewRef.get() ?: return
    val spannable = textView.text as? Spannable ?: return

    if (isReducedMotionEnabled(textView.context)) return

    val fadeSpan = FadeInSpan().apply { alpha = 0f }
    spannable.setSpan(fadeSpan, tailStart, tailEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)

    val animator =
      ValueAnimator.ofFloat(0f, 1f).apply {
        duration = FADE_DURATION_MS
        interpolator = LinearInterpolator()

        addUpdateListener { anim ->
          fadeSpan.alpha = anim.animatedValue as Float
          val tv = viewRef.get() ?: return@addUpdateListener
          val currentSpannable = tv.text as? Spannable ?: return@addUpdateListener

          val end = minOf(tailEnd, currentSpannable.length)
          if (end > tailStart) {
            currentSpannable.setSpan(fadeSpan, tailStart, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
          }
          tv.invalidate()
        }

        addListener(
          object : AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: Animator) {
              cleanup(fadeSpan)
            }

            override fun onAnimationCancel(animation: Animator) {
              cleanup(fadeSpan)
            }
          },
        )
      }

    activeAnimations[fadeSpan] = animator
    animator.start()
  }

  private fun cleanup(span: FadeInSpan) {
    activeAnimations.remove(span)
    val spannable = viewRef.get()?.text as? Spannable ?: return
    span.alpha = 1f
    spannable.removeSpan(span)
  }

  fun cancelAll() {
    val spans = activeAnimations.keys.toList()
    spans.forEach { activeAnimations[it]?.cancel() }
    activeAnimations.clear()
  }

  companion object {
    private const val FADE_DURATION_MS = 150L
  }
}
