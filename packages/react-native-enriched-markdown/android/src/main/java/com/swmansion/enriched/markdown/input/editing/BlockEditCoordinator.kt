package com.swmansion.enriched.markdown.input.editing

import android.text.Editable
import com.swmansion.enriched.markdown.input.formatting.BlockStore
import com.swmansion.enriched.markdown.input.model.BlockRange
import com.swmansion.enriched.markdown.input.model.BlockType
import com.swmansion.enriched.markdown.input.model.MAX_LIST_DEPTH

/**
 * Encapsulates block-editing operations: toggling block types, adjusting
 * list depth, and querying the block at a given position. The view delegates
 * here and applies UI-level consequences (formatting, anchor sync, cursor
 * size, typing attributes) based on the returned result.
 *
 * All mutating methods normalize stores to line bounds before returning, so
 * the caller can re-stamp block spans immediately.
 */
class BlockEditCoordinator(
  private val blockStore: BlockStore,
) {
  // ── Queries ──────────────────────────────────────────────────────────

  fun blockAtPosition(
    text: CharSequence,
    pos: Int,
  ): BlockRange? {
    val lineStart = lineStartOf(text, pos)
    return blockStore.blockStartingAt(lineStart)
  }

  fun listBlockAtPosition(
    text: CharSequence,
    pos: Int,
  ): BlockRange? = blockAtPosition(text, pos)?.takeIf { it.type in BlockType.LIST_ITEMS }

  fun listBlockAtLineStart(lineStart: Int): BlockRange? = blockStore.blockStartingAt(lineStart)?.takeIf { it.type in BlockType.LIST_ITEMS }

  fun headingLevelAtPosition(
    text: CharSequence,
    pos: Int,
  ): Int {
    val block = blockAtPosition(text, pos) ?: return 0
    return if (block.type in BlockType.HEADINGS) block.level else 0
  }

  fun listStateAtPosition(
    text: CharSequence,
    pos: Int,
    type: BlockType,
  ): Pair<Boolean, Int> {
    val block = listBlockAtPosition(text, pos) ?: return false to 0
    return if (block.type == type) true to block.level else false to 0
  }

  // ── Mutations ────────────────────────────────────────────────────────

  /**
   * Toggles [type] at [level] on the paragraphs the selection touches.
   * Returns true when the block was already active (i.e. it was turned off).
   */
  fun toggleBlock(
    text: Editable,
    type: BlockType,
    level: Int,
    selStart: Int,
    selEnd: Int,
  ): Boolean {
    val existing = blockAtPosition(text, selStart)
    val wasActive = existing != null && existing.type == type && existing.level == level

    if (wasActive) {
      blockStore.removeBlock(selStart, selEnd, text)
    } else {
      forEachLine(text, selStart, selEnd) { ls, le ->
        blockStore.setBlock(type, level, ls, le, text)
      }
    }
    blockStore.normalizeToLineBounds(text)
    return wasActive
  }

  /**
   * Toggles a list of [type] on the selection: turns lines into depth-0
   * items (switching list type keeps each line's depth) or clears them back
   * to plain paragraphs when the cursor line already carries [type].
   * Returns true when the list was turned off.
   */
  fun toggleList(
    text: Editable,
    type: BlockType,
    cursorPos: Int,
    selStart: Int,
    selEnd: Int,
  ): Boolean {
    val turningOff = listBlockAtPosition(text, cursorPos)?.type == type
    if (turningOff) {
      forEachLine(text, selStart, selEnd) { ls, le ->
        blockStore.removeBlock(ls, le, text)
      }
    } else {
      forEachLine(text, selStart, selEnd) { ls, le ->
        val existing = listBlockAtLineStart(ls)
        blockStore.setBlock(type, existing?.level ?: 0, ls, le, text)
      }
    }
    blockStore.normalizeToLineBounds(text)
    return turningOff
  }

  enum class DepthChangeResult {
    /** Depth was adjusted on the existing list item(s). */
    CHANGED,

    /** No list existed; a new unordered list was started (delta > 0 only). */
    STARTED_LIST,

    /** Outdented at depth 0 — the list marker was removed. */
    EXITED_LIST,

    /** Nothing happened (e.g. outdent on a heading or plain paragraph). */
    NO_OP,
  }

  /**
   * Adjusts list depth by [delta] on the selected lines. When the cursor
   * is on a plain paragraph and delta > 0, starts a new unordered list.
   * When outdenting at depth 0, removes the list marker.
   *
   * Returns the action taken so the view can apply the appropriate UI effects.
   */
  fun changeDepth(
    text: Editable,
    cursorPos: Int,
    selStart: Int,
    selEnd: Int,
    delta: Int,
  ): DepthChangeResult {
    val cursorBlock = listBlockAtPosition(text, cursorPos)
    if (cursorBlock == null) {
      if (delta > 0 && blockAtPosition(text, cursorPos) == null) {
        toggleList(text, BlockType.UNORDERED_LIST_ITEM, cursorPos, selStart, selEnd)
        return DepthChangeResult.STARTED_LIST
      }
      return DepthChangeResult.NO_OP
    }
    if (delta < 0 && cursorBlock.level == 0) {
      toggleList(text, cursorBlock.type, cursorPos, selStart, selEnd)
      return DepthChangeResult.EXITED_LIST
    }

    forEachLine(text, selStart, selEnd) { ls, _ ->
      val block = listBlockAtLineStart(ls)
      if (block != null) {
        val newDepth = (block.level + delta).coerceIn(0, MAX_LIST_DEPTH)
        blockStore.setBlock(block.type, newDepth, ls, ls, text)
      }
    }
    blockStore.normalizeToLineBounds(text)
    return DepthChangeResult.CHANGED
  }

  // ── Line utilities ───────────────────────────────────────────────────

  fun lineStartOf(
    text: CharSequence,
    pos: Int,
  ): Int {
    var s = pos.coerceIn(0, text.length)
    while (s > 0 && !text[s - 1].isLineBreak()) s--
    return s
  }

  fun lineEndOf(
    text: CharSequence,
    pos: Int,
  ): Int {
    var e = pos.coerceIn(0, text.length)
    while (e < text.length && !text[e].isLineBreak()) e++
    return e
  }

  private inline fun forEachLine(
    text: CharSequence,
    selStart: Int,
    selEnd: Int,
    action: (lineStart: Int, lineEnd: Int) -> Unit,
  ) {
    var cursor = lineStartOf(text, selStart)
    while (cursor <= text.length) {
      val le = lineEndOf(text, cursor)
      action(cursor, le)
      if (le >= selEnd) break
      cursor = le + 1
    }
  }
}
