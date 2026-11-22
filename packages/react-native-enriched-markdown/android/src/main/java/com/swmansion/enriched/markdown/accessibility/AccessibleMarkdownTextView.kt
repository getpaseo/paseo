package com.swmansion.enriched.markdown.accessibility

import android.content.Context
import android.graphics.Rect
import android.util.AttributeSet
import android.view.KeyEvent
import android.view.MotionEvent
import androidx.appcompat.widget.AppCompatTextView
import com.swmansion.enriched.markdown.spans.LinkPillSpan
import com.swmansion.enriched.markdown.utils.text.span.prepareWidthAwareSpans

/** AppCompatTextView with built-in TalkBack support via MarkdownAccessibilityHelper. */
abstract class AccessibleMarkdownTextView
  @JvmOverloads
  constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
  ) : AppCompatTextView(context, attrs, defStyleAttr) {
    val accessibilityHelper = MarkdownAccessibilityHelper(this)

    override fun setText(
      text: CharSequence?,
      type: BufferType?,
    ) {
      // Prime pills before the layout for the new text is built, and register for icons
      // that load later. Runs from the TextView constructor too: use nothing initialized after it.
      val contentWidth = width - compoundPaddingLeft - compoundPaddingRight
      if (contentWidth > 0) prepareWidthAwareSpans(text, contentWidth, includeImages = false)
      LinkPillSpan.registerView(text, this)
      super.setText(text, type)
    }

    override fun onMeasure(
      widthMeasureSpec: Int,
      heightMeasureSpec: Int,
    ) {
      if (MeasureSpec.getMode(widthMeasureSpec) != MeasureSpec.UNSPECIFIED) {
        val width = (MeasureSpec.getSize(widthMeasureSpec) - compoundPaddingLeft - compoundPaddingRight).coerceAtLeast(1)
        // TextView keeps its layout when the new width still fits the old lines.
        if (prepareWidthAwareSpans(text, width, includeImages = false) && layout != null) dropTextLayout()
      }
      super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }

    /**
     * Makes the next measure build a fresh text layout. TextView exposes no direct way:
     * re-setting the text would copy it and clear the selection, while setting the break
     * strategy, even to its current value, discards the layout and nothing else.
     */
    private fun dropTextLayout() {
      breakStrategy = breakStrategy
    }

    override fun dispatchHoverEvent(event: MotionEvent): Boolean =
      accessibilityHelper.dispatchHoverEvent(event) || super.dispatchHoverEvent(event)

    override fun dispatchKeyEvent(event: KeyEvent): Boolean = accessibilityHelper.dispatchKeyEvent(event) || super.dispatchKeyEvent(event)

    override fun onFocusChanged(
      gainFocus: Boolean,
      direction: Int,
      previouslyFocusedRect: Rect?,
    ) {
      super.onFocusChanged(gainFocus, direction, previouslyFocusedRect)
      accessibilityHelper.onFocusChanged(gainFocus, direction, previouslyFocusedRect)
    }

    override fun onDetachedFromWindow() {
      // Before super, and here rather than in a ViewManager's
      // onDropViewInstance: getViewTreeObserver() returns the WINDOW's observer
      // only while the view is attached. Once detached it hands back the view's
      // own floating observer, so a removal then would target the wrong
      // observer and leave the listener on the window.
      accessibilityHelper.cleanup()
      super.onDetachedFromWindow()
    }
  }
