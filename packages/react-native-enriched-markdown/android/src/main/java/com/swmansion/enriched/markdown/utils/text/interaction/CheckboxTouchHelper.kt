package com.swmansion.enriched.markdown.utils.text.interaction

import android.view.MotionEvent
import android.view.ViewConfiguration
import android.widget.TextView
import com.swmansion.enriched.markdown.utils.text.interaction.TaskListHitTestResult
import com.swmansion.enriched.markdown.utils.text.interaction.TaskListTapUtils
import kotlin.math.abs

class CheckboxTouchHelper(
  private val textView: TextView,
) {
  var onCheckboxTap: ((taskIndex: Int, checked: Boolean, itemText: String) -> Unit)? = null

  /**
   * When false, checkbox taps are ignored: hit-testing is skipped and no
   * gesture is consumed, so the tap falls through to the text view unchanged.
   */
  var isEnabled: Boolean = true

  private var touchDownX = 0f
  private var touchDownY = 0f
  private var pendingHit: TaskListHitTestResult? = null
  private val touchSlop: Int by lazy { ViewConfiguration.get(textView.context).scaledTouchSlop }

  /** Returns `true` if the event was consumed by a checkbox gesture. */
  fun onTouchEvent(event: MotionEvent): Boolean {
    if (!isEnabled) return false
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        val hit = TaskListTapUtils.hitTest(textView, event.x, event.y) ?: return false
        touchDownX = event.x
        touchDownY = event.y
        pendingHit = hit
        return true
      }

      MotionEvent.ACTION_MOVE -> {
        if (pendingHit != null && isExceedingSlop(event)) {
          pendingHit = null
        }
      }

      MotionEvent.ACTION_UP -> {
        val hit = pendingHit ?: return false
        pendingHit = null
        if (!isExceedingSlop(event)) {
          onCheckboxTap?.invoke(hit.taskIndex, hit.checked, hit.itemText)
        }
        return true
      }

      MotionEvent.ACTION_CANCEL -> {
        pendingHit = null
      }
    }
    return pendingHit != null
  }

  private fun isExceedingSlop(event: MotionEvent): Boolean = abs(event.x - touchDownX) > touchSlop || abs(event.y - touchDownY) > touchSlop
}
