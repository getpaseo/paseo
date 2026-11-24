package com.swmansion.enriched.markdown.input.formatting

import com.swmansion.enriched.markdown.input.model.FormattingRange
import com.swmansion.enriched.markdown.input.model.StyleType
import java.util.Collections

class FormattingStore {
  private val ranges = mutableListOf<FormattingRange>()

  val allRanges: List<FormattingRange> get() = Collections.unmodifiableList(ranges)

  fun setRanges(newRanges: List<FormattingRange>) {
    ranges.clear()
    ranges.addAll(newRanges.sortedBy { it.start })
  }

  fun clearAll() {
    ranges.clear()
  }

  fun rangeOfType(
    type: StyleType,
    containingPosition: Int,
  ): FormattingRange? = ranges.firstOrNull { it.type == type && containingPosition >= it.start && containingPosition < it.end }

  fun isStyleActive(
    type: StyleType,
    position: Int,
  ): Boolean = rangeOfType(type, position) != null

  fun isStyleActiveInRange(
    type: StyleType,
    start: Int,
    end: Int,
  ): Boolean = ranges.any { it.type == type && it.start < end && it.end > start }

  /**
   * Snaps a selection so it never partially overlaps an atomic link: a partial selection expands to
   * the whole link, a caret inside a link moves to its end. Returns the adjusted (start, end) or null.
   */
  fun selectionAdjustedForAtomicLinks(
    start: Int,
    end: Int,
  ): Pair<Int, Int>? {
    if (start != end) {
      var newStart = start
      var newEnd = end
      rangeOfType(StyleType.LINK, newStart)?.let { newStart = minOf(newStart, it.start) }
      if (newEnd > 0) rangeOfType(StyleType.LINK, newEnd - 1)?.let { newEnd = maxOf(newEnd, it.end) }
      return if (newStart != start || newEnd != end) Pair(newStart, newEnd) else null
    }
    val link = rangeOfType(StyleType.LINK, start)
    return if (link != null && start > link.start && start < link.end) Pair(link.end, link.end) else null
  }

  enum class ToggleResult {
    /** The style was active and has been removed (or is active at the caret). */
    WAS_ACTIVE,

    /** The style was inactive and has been added (or is inactive at the caret). */
    WAS_INACTIVE,
  }

  /**
   * Toggles [type] on the range `[start, end)`. For a selection (`start < end`),
   * removes the style when active at `start`, otherwise strips [conflictingStyles]
   * and adds it. For a caret (`start == end`), reports the current state without
   * mutating — the caller manages pending-style bookkeeping.
   */
  fun toggleStyle(
    type: StyleType,
    start: Int,
    end: Int,
    conflictingStyles: Set<StyleType>,
  ): ToggleResult {
    val isActive = isStyleActive(type, start)
    if (start < end) {
      if (isActive) {
        removeType(type, start, end)
      } else {
        for (conflict in conflictingStyles) {
          removeType(conflict, start, end)
        }
        addRange(FormattingRange(type, start, end))
      }
    }
    return if (isActive) ToggleResult.WAS_ACTIVE else ToggleResult.WAS_INACTIVE
  }

  /**
   * Returns true when toggling [type] ON at [position] should be refused
   * because one of the [blockingStyles] is currently active there.
   * Toggling OFF (the style is already active) is never blocked.
   */
  fun isToggleBlocked(
    type: StyleType,
    position: Int,
    blockingStyles: Set<StyleType>,
  ): Boolean {
    if (blockingStyles.isEmpty()) return false
    if (isStyleActive(type, position)) return false
    return blockingStyles.any { isStyleActive(it, position) }
  }

  fun addRange(newRange: FormattingRange) {
    var mergedStart = newRange.start
    var mergedEnd = newRange.end
    val mergeIndexes = mutableListOf<Int>()

    for ((idx, existing) in ranges.withIndex()) {
      if (existing.type != newRange.type) continue
      if (existing.start <= mergedEnd && existing.end >= mergedStart) {
        mergedStart = minOf(mergedStart, existing.start)
        mergedEnd = maxOf(mergedEnd, existing.end)
        mergeIndexes.add(idx)
      }
    }

    for (idx in mergeIndexes.reversed()) {
      ranges.removeAt(idx)
    }

    val merged = FormattingRange(newRange.type, mergedStart, mergedEnd, newRange.url)
    val insertAt = sortedInsertionIndex(ranges, mergedStart)
    ranges.add(insertAt, merged)
  }

  fun removeType(
    type: StyleType,
    start: Int,
    end: Int,
  ) {
    val remainders = mutableListOf<FormattingRange>()
    val indexesToRemove = mutableListOf<Int>()

    for ((idx, existing) in ranges.withIndex()) {
      if (existing.type != type) continue
      if (existing.end <= start || existing.start >= end) continue

      indexesToRemove.add(idx)

      if (existing.start < start) {
        remainders.add(FormattingRange(type, existing.start, start, existing.url))
      }
      if (existing.end > end) {
        remainders.add(FormattingRange(type, end, existing.end, existing.url))
      }
    }

    for (idx in indexesToRemove.reversed()) {
      ranges.removeAt(idx)
    }

    // Remainders are fragments of a just-removed range and cannot overlap others.
    for (remainder in remainders) {
      val insertAt = sortedInsertionIndex(ranges, remainder.start)
      ranges.add(insertAt, remainder)
    }
  }

  fun removeRange(range: FormattingRange) {
    ranges.remove(range)
  }

  /** Shifts/clips formatting ranges to follow a text edit. See [RangeEditAdjustment]. */
  fun adjustForEdit(
    editLocation: Int,
    deletedLength: Int,
    insertedLength: Int,
  ) {
    RangeEditAdjustment.adjustForEdit(
      ranges,
      editLocation,
      deletedLength,
      insertedLength,
      inheritsReplacementAtStart = { it.type != StyleType.LINK },
    )
    coalesceAdjacentSameTypeRanges()
  }

  /**
   * Merge same-type (and same-url) ranges left adjacent or overlapping by an
   * edit — e.g. deleting the space in "**foo** **bar**" leaves two touching
   * bold ranges that would serialize as "**foo****bar**". [addRange] keeps
   * this invariant on insert; the edit path must too.
   */
  private fun coalesceAdjacentSameTypeRanges() {
    var idx = 0
    while (idx < ranges.size) {
      val current = ranges[idx]
      var next = idx + 1
      while (next < ranges.size && ranges[next].start <= current.end) {
        val candidate = ranges[next]
        if (candidate.type == current.type && candidate.url == current.url) {
          current.end = maxOf(current.end, candidate.end)
          ranges.removeAt(next)
        } else {
          next++
        }
      }
      idx++
    }
  }
}
