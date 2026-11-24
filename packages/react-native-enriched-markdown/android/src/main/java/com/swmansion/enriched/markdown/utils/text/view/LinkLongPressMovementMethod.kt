package com.swmansion.enriched.markdown.utils.text.view

import android.os.Handler
import android.os.Looper
import android.text.Spannable
import android.text.method.ArrowKeyMovementMethod
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewParent
import android.widget.TextView
import com.swmansion.enriched.markdown.spans.CodeBlockSpan
import com.swmansion.enriched.markdown.spans.ImageSpan
import com.swmansion.enriched.markdown.spans.LinkSpan
import com.swmansion.enriched.markdown.spans.SpoilerSpan
import com.swmansion.enriched.markdown.spoiler.SpoilerCapable
import kotlin.math.abs

/**
 * Movement method that adds link tap / long-press and spoiler tap handling on
 * top of [ArrowKeyMovementMethod], the method [setTextIsSelectable] installs.
 *
 * Must never mutate the buffer's Selection spans — the platform Editor
 * manages them during long-press gestures, and removing or overwriting
 * them mid-gesture crashes on some OEM skins.
 * See: https://github.com/software-mansion/enriched-markdown/issues/580
 */
class LinkLongPressMovementMethod : ArrowKeyMovementMethod() {
  private val handler = Handler(Looper.getMainLooper())
  private var longPressRunnable: Runnable? = null

  private var startX = 0f
  private var startY = 0f
  private var pressedLink: LinkSpan? = null
  private var pressedImage: ImageSpan? = null
  private var pressedCodeBlock: CodeBlockSpan? = null

  var isLinkTouchActive: Boolean = false
    private set
  private var isTouchWithinTextBounds: Boolean = true

  override fun onTouchEvent(
    widget: TextView,
    buffer: Spannable,
    event: MotionEvent,
  ): Boolean {
    when (event.action) {
      MotionEvent.ACTION_DOWN -> {
        startX = event.x
        startY = event.y

        pressedLink = findLinkSpan(widget, buffer, event)
        pressedImage =
          if (pressedLink == null && imagePressHost(widget)?.imagePressEnabled == true) {
            findImageSpan(widget, buffer, event)
          } else {
            null
          }
        pressedCodeBlock =
          if (pressedLink == null &&
            pressedImage == null &&
            // Skip while text is selected so the tap clears the selection
            // instead of firing the press (matches the web guard).
            !widget.hasSelection() &&
            codeBlockPressHost(widget)?.codeBlockPressEnabled == true
          ) {
            findCodeBlockSpan(widget, buffer, event)
          } else {
            null
          }
        isLinkTouchActive = pressedLink != null || pressedImage != null || pressedCodeBlock != null
        isTouchWithinTextBounds = charOffsetAt(widget, event) != null || pressedCodeBlock != null
        pressedLink?.let { scheduleLongPress(widget, it) }
      }

      MotionEvent.ACTION_MOVE -> {
        val config = ViewConfiguration.get(widget.context)
        if (abs(event.x - startX) > config.scaledTouchSlop ||
          abs(event.y - startY) > config.scaledTouchSlop
        ) {
          cancelLongPress()
          isLinkTouchActive = false
          pressedLink = null
          pressedImage = null
          pressedCodeBlock = null
        }
      }

      MotionEvent.ACTION_UP -> {
        cancelLongPress()
        val tappedLink = pressedLink
        val tappedImage = pressedImage
        val tappedCodeBlock = pressedCodeBlock
        isLinkTouchActive = false
        pressedLink = null
        pressedImage = null
        pressedCodeBlock = null

        if (handleSpoilerTap(widget, buffer, event)) {
          return true
        }

        // LinkSpan.onClick itself swallows the click that follows a completed
        // long-press (and resets its internal flag), so it is always invoked
        // for a tap that started and ended on the same link.
        if (tappedLink != null && findLinkSpan(widget, buffer, event) === tappedLink) {
          tappedLink.onClick(widget)
          return true
        }

        if (tappedImage != null && findImageSpan(widget, buffer, event) === tappedImage) {
          imagePressHost(widget)?.emitOnImagePress(tappedImage.imageUrl, tappedImage.altText)
          return true
        }

        if (tappedCodeBlock != null && findCodeBlockSpan(widget, buffer, event) === tappedCodeBlock) {
          codeBlockPressHost(widget)?.emitOnCodeBlockPress(tappedCodeBlock.code, tappedCodeBlock.language)
          return true
        }
      }

      MotionEvent.ACTION_CANCEL -> {
        cancelLongPress()
        isLinkTouchActive = false
        pressedLink = null
        pressedImage = null
        pressedCodeBlock = null
      }
    }

    // getOffsetForHorizontal snaps to the nearest character, so without this
    // guard taps in empty space past the end of a line would still be treated
    // as text touches. Let them fall through to the parent (e.g. RNGH
    // Pressable) instead.
    if (!isTouchWithinTextBounds) {
      return false
    }

    return super.onTouchEvent(widget, buffer, event)
  }

  private fun scheduleLongPress(
    widget: TextView,
    span: LinkSpan,
  ) {
    cancelLongPress()

    longPressRunnable =
      Runnable {
        // Execute the long click logic on the span
        if (span.onLongClick(widget)) {
          // If consumed, cancel the system's own long-press logic (like context menus)
          widget.cancelLongPress()
        }
        longPressRunnable = null
      }.also {
        handler.postDelayed(it, ViewConfiguration.getLongPressTimeout().toLong())
      }
  }

  private fun cancelLongPress() {
    longPressRunnable?.let(handler::removeCallbacks)
    longPressRunnable = null
  }

  private fun charOffsetAt(
    widget: TextView,
    event: MotionEvent,
  ): Int? {
    val x = event.x - widget.totalPaddingLeft + widget.scrollX
    val y = event.y - widget.totalPaddingTop + widget.scrollY
    val layout = widget.layout ?: return null

    // getLineForVertical clamps to the first/last line for out-of-range
    // values, so taps in vertical padding would silently map to a real
    // line. Reject them before proceeding.
    if (y < 0f || y > layout.height) {
      return null
    }

    val line = layout.getLineForVertical(y.toInt())

    // getOffsetForHorizontal snaps to the nearest character even when the
    // tap is outside the actual text content (e.g. empty space after the
    // last word on a line). Guard against that by checking the tap falls
    // within the line's text bounds.
    if (x < layout.getLineLeft(line) || x > layout.getLineRight(line)) {
      return null
    }

    return layout.getOffsetForHorizontal(line, x)
  }

  private fun findLinkSpan(
    widget: TextView,
    buffer: Spannable,
    event: MotionEvent,
  ): LinkSpan? {
    val offset = charOffsetAt(widget, event) ?: return null
    return buffer.getSpans(offset, offset, LinkSpan::class.java).firstOrNull()
  }

  private fun findImageSpan(
    widget: TextView,
    buffer: Spannable,
    event: MotionEvent,
  ): ImageSpan? {
    val offset = charOffsetAt(widget, event) ?: return null
    return buffer.getSpans(offset, offset, ImageSpan::class.java).firstOrNull()
  }

  private fun imagePressHost(widget: View): ImagePressHost? {
    if (widget is ImagePressHost) return widget
    var parent: ViewParent? = widget.parent
    while (parent != null && parent !is ImagePressHost) {
      parent = parent.parent
    }
    return parent as? ImagePressHost
  }

  // A code block is a whole-line box, so this matches a tap anywhere on the line
  // (ignoring x), unlike charOffsetAt which needs an exact glyph.
  private fun findCodeBlockSpan(
    widget: TextView,
    buffer: Spannable,
    event: MotionEvent,
  ): CodeBlockSpan? {
    val layout = widget.layout ?: return null
    val y = event.y - widget.totalPaddingTop + widget.scrollY
    if (y < 0f || y > layout.height) return null
    val line = layout.getLineForVertical(y.toInt())
    val lineStart = layout.getLineStart(line)
    val lineEnd = layout.getLineEnd(line)
    return buffer.getSpans(lineStart, lineEnd, CodeBlockSpan::class.java).firstOrNull()
  }

  private fun codeBlockPressHost(widget: View): CodeBlockPressHost? {
    if (widget is CodeBlockPressHost) return widget
    var parent: ViewParent? = widget.parent
    while (parent != null && parent !is CodeBlockPressHost) {
      parent = parent.parent
    }
    return parent as? CodeBlockPressHost
  }

  private fun handleSpoilerTap(
    widget: TextView,
    buffer: Spannable,
    event: MotionEvent,
  ): Boolean {
    val offset = charOffsetAt(widget, event) ?: return false
    val tappedSpan =
      buffer
        .getSpans(offset, offset, SpoilerSpan::class.java)
        .firstOrNull { !it.revealed && !it.revealing } ?: return false

    val drawer = (widget as? SpoilerCapable)?.spoilerOverlayDrawer ?: return false
    val spans = expandContiguousSpoilers(buffer, tappedSpan)
    val remaining = intArrayOf(spans.size)

    for (span in spans) {
      drawer.revealSpan(span) {
        remaining[0]--
        if (remaining[0] <= 0) widget.invalidate()
      }
    }
    widget.invalidate()
    return true
  }

  private fun expandContiguousSpoilers(
    buffer: Spannable,
    seed: SpoilerSpan,
  ): List<SpoilerSpan> {
    val allSpans = buffer.getSpans(0, buffer.length, SpoilerSpan::class.java)
    if (allSpans.size <= 1) return listOf(seed)

    val result = mutableSetOf(seed)
    var rangeStart = buffer.getSpanStart(seed)
    var rangeEnd = buffer.getSpanEnd(seed)
    var changed = true
    while (changed) {
      changed = false
      for (span in allSpans) {
        if (span in result) continue
        val spanStart = buffer.getSpanStart(span)
        val spanEnd = buffer.getSpanEnd(span)
        if (spanEnd >= rangeStart && spanStart <= rangeEnd) {
          result.add(span)
          if (spanStart < rangeStart) rangeStart = spanStart
          if (spanEnd > rangeEnd) rangeEnd = spanEnd
          changed = true
        }
      }
    }
    return result.sortedBy { buffer.getSpanStart(it) }
  }

  companion object {
    @JvmStatic
    fun createInstance(): LinkLongPressMovementMethod = LinkLongPressMovementMethod()
  }
}
