package com.swmansion.enriched.markdown.renderer

import com.swmansion.enriched.markdown.styles.ListStyle

/**
 * Manages list context transitions (entering/exiting lists, handling nesting, etc.).
 * Centralizes logic for managing list depth, item numbers, and parent context restoration.
 *
 * Key concepts:
 * - **listDepth**: Tracks nesting level (0 = top-level, 1 = first nested, etc.)
 * - **Stack-based numbering**: Pushes parent's item number when entering nested ordered lists,
 *   allowing each level to maintain its own counter while preserving parent's position.
 * - **Parent context restoration**: Restores parent list's style when exiting nested lists
 *   so subsequent parent items render correctly.
 */
class ListContextManager(
  private val context: BlockStyleContext,
) {
  /**
   * Captures the state when entering a list, needed for proper restoration when exiting.
   * This ensures we can restore the exact parent context even after nested lists modify it.
   */
  data class ListEntryState(
    val previousDepth: Int,
    val parentListType: BlockStyleContext.ListType?,
    val wasNestedInOrderedList: Boolean,
  )

  /**
   * Enters a list context. Handles:
   * - Saving parent list item numbers to stack (for ordered lists) before resetting counter
   * - Incrementing list depth
   * - Setting the appropriate list style
   * - Resetting item number for the new list
   */
  fun enterList(
    listType: BlockStyleContext.ListType,
    style: ListStyle,
    startNumber: Int = 1,
  ): ListEntryState {
    val previousDepth = context.listDepth
    val isNested = previousDepth > 0
    val parentListType = if (isNested) context.listType else null
    val parentIsOrdered = parentListType == BlockStyleContext.ListType.ORDERED

    // Push parent's item number to stack before resetting for nested list.
    // Even if entering an unordered list, we need to save if parent is ordered.
    if (isNested && parentIsOrdered) {
      context.pushOrderedListItemNumber()
    }

    context.listDepth = previousDepth + 1
    when (listType) {
      BlockStyleContext.ListType.ORDERED -> {
        context.setOrderedListStyle(style)
      }

      BlockStyleContext.ListType.UNORDERED -> {
        context.setUnorderedListStyle(style)
      }
    }
    context.resetListItemNumber(startNumber)

    return ListEntryState(
      previousDepth = previousDepth,
      parentListType = parentListType,
      wasNestedInOrderedList = isNested && parentIsOrdered,
    )
  }

  /**
   * Exits a list context. Handles:
   * - Popping current list block style from stack
   * - Decrementing list depth back to previousDepth
   * - Restoring parent list item numbers from stack (if applicable)
   * - Restoring parent list metadata (if nested) so subsequent parent items render correctly
   */
  fun exitList(entryState: ListEntryState) {
    context.listDepth = entryState.previousDepth
    context.clearListStyle()

    if (entryState.wasNestedInOrderedList) {
      context.popOrderedListItemNumber()
    }

    if (entryState.previousDepth > 0) {
      context.listType = entryState.parentListType
    }
  }
}
