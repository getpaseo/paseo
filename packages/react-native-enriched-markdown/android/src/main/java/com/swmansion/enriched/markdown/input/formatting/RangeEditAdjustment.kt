package com.swmansion.enriched.markdown.input.formatting

import com.swmansion.enriched.markdown.input.model.MutableRangeBounds

internal fun <T : MutableRangeBounds> sortedInsertionIndex(
  ranges: List<T>,
  location: Int,
): Int {
  var index = 0
  for (existing in ranges) {
    if (existing.start > location) break
    index++
  }
  return index
}

/**
 * Shared shift/clip logic applied to stored ranges after a text edit. Both
 * [FormattingStore] and [BlockStore] delegate here so the overlap
 * classification lives in exactly one place.
 */
internal object RangeEditAdjustment {
  /**
   * Mutates [ranges] in place to follow an edit that replaced [deletedLength]
   * characters at [editLocation] with [insertedLength] characters. Ranges
   * deleted outright or clipped to zero length are removed.
   *
   * Insert-only edits at exactly `range.end` do NOT grow the range — the typed
   * characters stay outside it. An insert at exactly `range.start` grows the
   * range only when [growsAtStartOnInsert] returns true; otherwise the range
   * shifts and the typed characters stay outside it. Whether boundary text
   * otherwise joins the range is decided elsewhere: pending styles for inline
   * ranges, line re-normalization for block ranges.
   *
   * [inheritsReplacementAtStart]: when it returns true for a range whose start
   * is the edit location, replacement text joins the range (UIKit attribute
   * inheritance); when false, the old clip/remove behavior applies.
   *
   * [growsAtStartOnInsert]: when it returns true, a pure insert at `range.start`
   * grows the range to cover the inserted text instead of shifting the range
   * past it. Block ranges own their whole line, so a character typed at the line
   * start must keep the line's block; inline styles must NOT set this (a
   * character typed before a bold run must not become bold).
   */
  fun <T : MutableRangeBounds> adjustForEdit(
    ranges: MutableList<T>,
    editLocation: Int,
    deletedLength: Int,
    insertedLength: Int,
    inheritsReplacementAtStart: (T) -> Boolean = { false },
    growsAtStartOnInsert: (T) -> Boolean = { false },
  ) {
    if (deletedLength == 0 && insertedLength == 0) return

    val deleteEnd = editLocation + deletedLength
    val indexesToRemove = mutableListOf<Int>()

    for ((idx, range) in ranges.withIndex()) {
      if (deletedLength > 0) {
        val inheritsReplacement =
          insertedLength > 0 && range.start == editLocation && inheritsReplacementAtStart(range)
        when (classifyOverlap(range.start, range.end, editLocation, deleteEnd)) {
          EditOverlap.BEFORE_EDIT -> { /* no change */ }

          EditOverlap.AFTER_EDIT -> {
            range.start = range.start - deletedLength + insertedLength
            range.end = range.end - deletedLength + insertedLength
          }

          EditOverlap.FULLY_DELETED -> {
            if (inheritsReplacement) {
              range.start = editLocation
              range.end = editLocation + insertedLength
            } else {
              indexesToRemove.add(idx)
            }
          }

          EditOverlap.DELETED_INSIDE -> {
            range.end = range.end - deletedLength + insertedLength
          }

          EditOverlap.CLIPPED_END -> {
            val newEnd = editLocation + insertedLength
            val newLength = if (newEnd > range.start) newEnd - range.start else 0
            range.end = range.start + newLength
            if (newLength == 0) indexesToRemove.add(idx)
          }

          EditOverlap.CLIPPED_START -> {
            val charsClipped = deleteEnd - range.start
            val survivingLength = range.end - range.start - charsClipped
            if (inheritsReplacement) {
              range.start = editLocation
              range.end = editLocation + insertedLength + survivingLength
            } else {
              range.start = editLocation + insertedLength
              range.end = range.start + survivingLength
              if (survivingLength == 0) indexesToRemove.add(idx)
            }
          }
        }
      } else {
        when {
          range.start == editLocation && growsAtStartOnInsert(range) -> {
            range.end += insertedLength
          }

          range.start >= editLocation -> {
            range.start += insertedLength
            range.end += insertedLength
          }

          editLocation > range.start && editLocation < range.end -> {
            range.end += insertedLength
          }
        }
      }
    }

    for (idx in indexesToRemove.reversed()) {
      ranges.removeAt(idx)
    }

    ranges.removeAll { it.end - it.start == 0 }
  }

  private enum class EditOverlap {
    BEFORE_EDIT,
    AFTER_EDIT,
    FULLY_DELETED,
    DELETED_INSIDE,
    CLIPPED_END,
    CLIPPED_START,
  }

  private fun classifyOverlap(
    rangeStart: Int,
    rangeEnd: Int,
    editLocation: Int,
    deleteEnd: Int,
  ): EditOverlap {
    if (rangeEnd <= editLocation) return EditOverlap.BEFORE_EDIT
    if (rangeStart >= deleteEnd) return EditOverlap.AFTER_EDIT
    if (rangeStart >= editLocation && rangeEnd <= deleteEnd) return EditOverlap.FULLY_DELETED
    if (rangeStart < editLocation && rangeEnd > deleteEnd) return EditOverlap.DELETED_INSIDE
    return if (rangeStart < editLocation) EditOverlap.CLIPPED_END else EditOverlap.CLIPPED_START
  }
}
