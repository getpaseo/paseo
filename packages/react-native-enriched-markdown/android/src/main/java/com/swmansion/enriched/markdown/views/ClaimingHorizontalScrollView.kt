package com.swmansion.enriched.markdown.views

import android.content.Context
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.widget.HorizontalScrollView
import kotlin.math.abs

/** Claims overflowing blocks before ancestor gesture handlers can activate. */
internal class ClaimingHorizontalScrollView(context: Context) : HorizontalScrollView(context) {
  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
  private var downX = 0f
  private var downY = 0f
  private var claimed = false

  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    if (event.actionMasked == MotionEvent.ACTION_DOWN) {
      downX = event.x
      downY = event.y
      claimed = canScrollHorizontally(-1) || canScrollHorizontally(1)
      if (claimed) parent.requestDisallowInterceptTouchEvent(true)
    }

    val handled = super.dispatchTouchEvent(event)
    when (event.actionMasked) {
      MotionEvent.ACTION_MOVE -> {
        if (claimed) {
          val dx = abs(event.x - downX)
          val dy = abs(event.y - downY)
          if (dy > dx && dy > touchSlop) {
            // Release after native dispatch, which can itself disallow interception.
            parent.requestDisallowInterceptTouchEvent(false)
            claimed = false
          }
        }
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> claimed = false
    }
    return handled
  }
}
