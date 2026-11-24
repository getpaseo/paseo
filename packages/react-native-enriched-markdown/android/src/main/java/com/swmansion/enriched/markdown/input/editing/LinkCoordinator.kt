package com.swmansion.enriched.markdown.input.editing

import android.text.Spannable
import com.swmansion.enriched.markdown.input.autolink.AutoLinkDetector
import com.swmansion.enriched.markdown.input.formatting.FormattingStore
import com.swmansion.enriched.markdown.input.model.FormattingRange
import com.swmansion.enriched.markdown.input.model.StyleType

class LinkCoordinator(
  private val formattingStore: FormattingStore,
  private val autoLinkDetector: AutoLinkDetector,
) {
  fun sanitizeUrl(url: String): String =
    url
      .replace("(", "%28")
      .replace(")", "%29")

  /**
   * The link a caret or selection refers to, shared by everything that acts on
   * "the current link" (style state, removing it) so they always agree. For a
   * selection it is the link containing the first selected character. For a
   * collapsed caret it is the link the caret is inside or right after: ranges
   * are half-open, and the caret often lands at `range.end` after tapping a
   * link.
   */
  fun linkForSelection(
    start: Int,
    end: Int,
  ): FormattingRange? =
    formattingStore.rangeOfType(StyleType.LINK, start)
      ?: if (start == end && start > 0) formattingStore.rangeOfType(StyleType.LINK, start - 1) else null

  /**
   * Updates the URL of the link at the selection if the selection lies within
   * it, or otherwise adds a link over a non-empty selection. Returns true if
   * anything changed.
   */
  fun setLinkUrl(
    url: String,
    start: Int,
    end: Int,
    editable: Spannable?,
  ): Boolean {
    // Update the link if selection is entirely within link
    linkForSelection(start, end)?.takeIf { start >= it.start && end <= it.end }?.let { link ->
      link.url = url
      if (editable != null) {
        autoLinkDetector.clearAutoLinkInRange(editable, link.start, link.end)
      }
      return true
    }

    // Insert a link at the selection (removing any existing links that overlap)
    if (start == end) return false
    if (editable != null) {
      autoLinkDetector.clearAutoLinkInRange(editable, start, end)
    }
    formattingStore.addRange(FormattingRange(StyleType.LINK, start, end, url))
    return true
  }

  fun addLink(
    url: String,
    start: Int,
    end: Int,
    editable: Spannable?,
  ) {
    if (start >= end) return
    if (editable != null) {
      autoLinkDetector.clearAutoLinkInRange(editable, start, end)
    }
    formattingStore.addRange(FormattingRange(StyleType.LINK, start, end, sanitizeUrl(url)))
  }

  fun removeLink(
    start: Int,
    end: Int,
  ): Boolean {
    val linkRange = linkForSelection(start, end) ?: return false
    formattingStore.removeRange(linkRange)
    return true
  }

  /**
   * Finds the link containing `position - 1` and returns its range for deletion.
   * Returns null if no link is found.
   */
  fun linkRangeForDeletion(position: Int): FormattingRange? {
    if (position <= 0) return null
    return formattingStore.rangeOfType(StyleType.LINK, position - 1)
  }
}
