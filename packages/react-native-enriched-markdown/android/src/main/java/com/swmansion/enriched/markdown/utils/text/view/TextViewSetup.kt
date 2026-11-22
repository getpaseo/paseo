package com.swmansion.enriched.markdown.utils.text.view

import android.graphics.Color
import android.os.Build
import android.text.GetChars
import android.text.Spannable
import android.text.SpannableString
import android.text.SpannableStringBuilder
import android.view.textclassifier.TextClassifier
import androidx.appcompat.widget.AppCompatTextView
import androidx.core.view.ViewCompat
import com.swmansion.enriched.markdown.accessibility.AccessibleMarkdownTextView

/**
 * Adopts the renderer's buffer instead of copying it: the default factory's copy is
 * quadratic in span count. Safe because each segment's buffer is owned by one view.
 */
private object NoCopySpannableFactory : Spannable.Factory() {
  override fun newSpannable(source: CharSequence): Spannable =
    when (source) {
      is SpannableStringBuilder -> InsertionOrderedSpannable(source)
      is Spannable -> source
      else -> SpannableString(source)
    }
}

/**
 * Hides that [buffer] is a `SpannableStringBuilder`. Layout reads a builder's paragraph
 * spans in position order rather than insertion order, which paints nested list margins
 * outer-first and pushes nested checkboxes an indent right.
 *
 * Hiding the type has a price, and it is deliberate: every paragraph-span query from
 * `Layout` now goes through the builder's sorted `getSpans` instead of the unsorted fast
 * path the framework reserves for builders. The `layout` benchmark in the example app's
 * `display-benchmark` covers that cost, so it is already accounted for. Do not
 * "optimise" this wrapper away.
 */
private class InsertionOrderedSpannable(
  private val buffer: SpannableStringBuilder,
) : Spannable,
  GetChars {
  override val length: Int get() = buffer.length

  override fun get(index: Int): Char = buffer[index]

  override fun subSequence(
    startIndex: Int,
    endIndex: Int,
  ): CharSequence = buffer.subSequence(startIndex, endIndex)

  override fun getChars(
    start: Int,
    end: Int,
    dest: CharArray,
    destoff: Int,
  ) = buffer.getChars(start, end, dest, destoff)

  override fun <T : Any?> getSpans(
    start: Int,
    end: Int,
    type: Class<T>,
  ): Array<T> = buffer.getSpans(start, end, type)

  override fun getSpanStart(tag: Any): Int = buffer.getSpanStart(tag)

  override fun getSpanEnd(tag: Any): Int = buffer.getSpanEnd(tag)

  override fun getSpanFlags(tag: Any): Int = buffer.getSpanFlags(tag)

  override fun nextSpanTransition(
    start: Int,
    limit: Int,
    type: Class<*>?,
  ): Int = buffer.nextSpanTransition(start, limit, type)

  override fun setSpan(
    what: Any,
    start: Int,
    end: Int,
    flags: Int,
  ) = buffer.setSpan(what, start, end, flags)

  override fun removeSpan(what: Any) = buffer.removeSpan(what)

  override fun toString(): String = buffer.toString()
}

fun AccessibleMarkdownTextView.setupAsMarkdownTextView() {
  setBackgroundColor(Color.TRANSPARENT)
  setSpannableFactory(NoCopySpannableFactory)
  includeFontPadding = false
  movementMethod = LinkLongPressMovementMethod.createInstance()
  setTextIsSelectable(true)
  customSelectionActionModeCallback = createSelectionActionModeCallback(this)
  // SmartSelectSprite crashes with "Center point is not inside any of the
  // rectangles!" when Layout.getSelection returns empty rects near an
  // ImageSpan (ReplacementSpan). NO_OP makes skipTextClassification() return
  // true, bypassing the entire SmartSelectSprite code path. Regular text
  // selection (long-press, handles, copy/paste) still works; only automatic
  // entity detection (phone numbers, addresses) is disabled.
  //
  // TODO: Add an Android-only `enableSmartTextSelection` prop that skips this
  // NO_OP override. This would let users who don't render images opt in to
  // entity detection. The prop should default to false and its docs should
  // warn that enabling it with markdown containing images will crash.
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
    setTextClassifier(TextClassifier.NO_OP)
  }
  isVerticalScrollBarEnabled = false
  isHorizontalScrollBarEnabled = false
  ViewCompat.setAccessibilityDelegate(this, accessibilityHelper)
}

fun AppCompatTextView.applySelectableState(selectable: Boolean) {
  if (isTextSelectable == selectable) return
  setTextIsSelectable(selectable)
  movementMethod = LinkLongPressMovementMethod.createInstance()
  if (!selectable && !isClickable) isClickable = true
}
