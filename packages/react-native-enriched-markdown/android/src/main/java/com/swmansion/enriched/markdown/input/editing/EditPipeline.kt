package com.swmansion.enriched.markdown.input.editing

import android.text.Editable
import com.swmansion.enriched.markdown.input.detection.DetectorPipeline
import com.swmansion.enriched.markdown.input.formatting.BlockStore
import com.swmansion.enriched.markdown.input.formatting.FormattingStore
import com.swmansion.enriched.markdown.input.formatting.InputFormatter
import com.swmansion.enriched.markdown.input.layout.InputEventEmitter
import com.swmansion.enriched.markdown.input.model.BlockType
import com.swmansion.enriched.markdown.input.model.FormattingRange
import com.swmansion.enriched.markdown.input.spans.ensureBodyLineHeightSpan

/**
 * Zero-width space: anchors an empty bullet line so the marker draws and the
 * caret indents (Android won't apply a LeadingMarginSpan's indent to an empty
 * paragraph). Stripped during serialization, so it never reaches the Markdown output.
 */
internal const val ZWSP = '\u200B'

internal fun Char.isLineBreak(): Boolean = this == '\n' || this == '\r' || this == '\u0085' || this == '\u2028' || this == '\u2029'

/**
 * View-specific operations the [EditPipeline] delegates back to its host.
 * Implemented by [EnrichedMarkdownTextInputView][com.swmansion.enriched.markdown.input.EnrichedMarkdownTextInputView].
 */
interface EditPipelineHost {
  val editable: Editable?
  val emitMarkdown: Boolean

  fun syncEmptyListAnchor(restamp: Boolean): Boolean

  fun forceScrollToSelection()

  fun syncCursorSizeWithBlock()

  fun updateActiveMention()

  fun runAsATransaction(block: () -> Unit)

  fun setViewSelection(position: Int)

  /** Which typed markdown prefixes (`# `, `- `, `1. `) convert into blocks. */
  val markdownShortcuts: MarkdownShortcutsConfig
}

/**
 * Orchestrates the per-keystroke edit pipeline: store adjustment, block
 * continuation, formatting, detection, and event emission.
 *
 * Phases run in a fixed order — each phase's postcondition is the next phase's
 * precondition. New block types add behavior to [continueBlocks] (via their
 * handler's [continuesOnNewline][com.swmansion.enriched.markdown.input.styles.BlockHandler.continuesOnNewline])
 * without touching this pipeline.
 */
class EditPipeline(
  private val formattingStore: FormattingStore,
  private val blockStore: BlockStore,
  private val formatter: InputFormatter,
  private val detectorPipeline: DetectorPipeline,
  private val eventEmitter: InputEventEmitter,
  private val host: EditPipelineHost,
) {
  /**
   * Main entry point — called once per user-driven text change. The [context]
   * captures the edit parameters and pre-edit state as an immutable snapshot.
   */
  fun processTextChange(context: EditContext) {
    adjustStores(context)
    pruneOrphanedAnchors()
    continueBlocks(context)
    convertMarkdownShortcut(context)
    host.editable?.let { blockStore.normalizeToLineBounds(it) }
    applyPendingStyles(context)

    // Settle the ZWSP anchor BEFORE stamping spans, so block formatting runs
    // exactly once over the final text/ranges — otherwise a pre-ZWSP and
    // post-ZWSP span would both land on the empty line ("double bullet" bug).
    val anchorChanged = host.syncEmptyListAnchor(restamp = false)
    val touchedNewline = anchorChanged || editTouchedNewline(context)

    applyInlineFormatting()
    applyBlockFormatting(touchedNewline, context.editStart, context.insertedLength)
    // formatter.bodyTextAttributes is the snapshot the view's applyFormatting()
    // takes after every prop change, so it matches the line height that
    // applyFormatting() and InputMeasurementStore use.
    host.editable?.let { ensureBodyLineHeightSpan(it, formatter.bodyTextAttributes) }
    detectLinks(context)

    host.forceScrollToSelection()
    host.syncCursorSizeWithBlock()

    eventEmitter.emitChangeText()
    if (host.emitMarkdown) eventEmitter.emitChangeMarkdown()
    host.updateActiveMention()
    eventEmitter.emitCaretRectChangeIfNeeded()
  }

  private fun adjustStores(context: EditContext) {
    formattingStore.adjustForEdit(context.editStart, context.deletedLength, context.insertedLength)
    blockStore.adjustForEdit(context.editStart, context.deletedLength, context.insertedLength)
  }

  /**
   * Drops anchored blocks (headings, list items) no longer anchored at a line
   * start (e.g. Backspace merged their line into the previous one). Must run
   * BEFORE [BlockStore.normalizeToLineBounds] so a merged range is judged on
   * its unsnapped anchor.
   *
   * Internal so the view's [adjustStoresForEdit][com.swmansion.enriched.markdown.input.EnrichedMarkdownTextInputView]
   * helper (used by programmatic text-mutation paths) can call it too.
   */
  internal fun pruneOrphanedAnchors() {
    val editable = host.editable ?: return
    val orphans =
      blockStore.allRanges.filter { range ->
        range.type in BlockType.ANCHORED && !isAtLineStart(editable, range.start)
      }
    for (orphan in orphans) {
      blockStore.removeBlock(orphan.start, orphan.start, editable)
    }
  }

  /**
   * After a newline insertion, continues a block whose handler reports
   * [continuesOnNewline][com.swmansion.enriched.markdown.input.styles.BlockHandler.continuesOnNewline]
   * onto the new line as a sibling at the same depth, or exits the block when
   * the emptied item gets a second Enter.
   */
  private fun continueBlocks(context: EditContext) {
    val editable = host.editable ?: return
    if (context.deletedLength != 0 || context.insertedLength <= 0) return
    val insertedEnd = (context.editStart + context.insertedLength).coerceAtMost(editable.length)
    val insertedNewline = (context.editStart until insertedEnd).any { editable[it] == '\n' }
    if (!insertedNewline) return

    val prevLineEnd = context.editStart
    var prevLineStart = prevLineEnd
    while (prevLineStart > 0 && editable[prevLineStart - 1] != '\n') prevLineStart--

    val prevBlock = blockStore.blockStartingAt(prevLineStart) ?: return
    val handler = formatter.handlerForBlock(prevBlock.type) ?: return
    if (!handler.continuesOnNewline) return

    val prevContentLength = (prevLineStart until prevLineEnd).count { editable[it] != ZWSP }
    if (prevContentLength == 0) {
      // Exit: clear the block AND delete the just-inserted newline so the empty
      // item collapses in place instead of leaving an extra indented blank line.
      blockStore.removeBlock(prevLineStart, prevLineEnd, editable)
      val newlineEnd = (context.editStart + context.insertedLength).coerceAtMost(editable.length)
      host.runAsATransaction { editable.delete(context.editStart, newlineEnd) }
      blockStore.adjustForEdit(context.editStart, context.insertedLength, 0)
      host.setViewSelection(prevLineStart.coerceAtMost(editable.length))
      return
    }

    val newLineStart = (context.editStart + context.insertedLength).coerceAtMost(editable.length)
    blockStore.setBlock(prevBlock.type, prevBlock.level, newLineStart, newLineStart, editable)
  }

  /**
   * Markdown shortcuts: a space typed after `#`…`######`, `-`/`*`/`+` or
   * `1.`/`1)` at the start of a plain paragraph drops the prefix and makes the
   * paragraph that block. Mirrors [continueBlocks]: mutate inside a transaction,
   * then re-adjust the stores for the deletion before normalization stamps spans.
   */
  private fun convertMarkdownShortcut(context: EditContext) {
    val config = host.markdownShortcuts
    if (!config.isEnabled) return
    val editable = host.editable ?: return
    if (context.deletedLength != 0 || context.insertedLength <= 0) return

    // The trigger is the first space in the inserted run, and a line break ends
    // the search so the converted line is always the one the insertion started
    // on. The line start itself is scanned the way [BlockStore] bounds a
    // paragraph, or the lookup below would miss the block.
    val insertedEnd = (context.editStart + context.insertedLength).coerceAtMost(editable.length)
    val spaceIndex =
      (context.editStart until insertedEnd)
        .asSequence()
        .takeWhile { !editable[it].isLineBreak() }
        .firstOrNull { editable[it] == ' ' } ?: return

    var lineStart = spaceIndex
    while (lineStart > 0 && editable[lineStart - 1] != '\n') lineStart--
    if (spaceIndex == lineStart || blockStore.blockStartingAt(lineStart) != null) return

    val match =
      MarkdownShortcutMatcher.match(
        editable.subSequence(lineStart, spaceIndex),
        config,
      ) ?: return

    val deleteEnd = spaceIndex + 1
    val deletedLength = deleteEnd - lineStart
    host.runAsATransaction { editable.delete(lineStart, deleteEnd) }
    formattingStore.adjustForEdit(lineStart, deletedLength, 0)
    blockStore.adjustForEdit(lineStart, deletedLength, 0)
    blockStore.setBlock(match.type, match.level, lineStart, lineStart, editable)

    val caret = (context.editStart + context.insertedLength - deletedLength).coerceIn(0, editable.length)
    host.setViewSelection(caret)
  }

  private fun applyPendingStyles(context: EditContext) {
    if (context.insertedLength == 0) return
    if (context.pendingStyles.isEmpty() && context.pendingStyleRemovals.isEmpty()) return

    val rangeStart =
      if (context.preEditSelectionStart != context.preEditSelectionEnd) {
        context.preEditSelectionStart
      } else {
        context.editStart
      }
    val rangeEnd = rangeStart + context.insertedLength

    // Skip applying pending styles when the insertion is only line breaks —
    // a phantom range over a bare newline corrupts isStyleActive() at the boundary.
    val currentText = host.editable
    val insertedHasGlyphContent =
      currentText != null &&
        rangeEnd <= currentText.length &&
        (rangeStart until rangeEnd).any { !currentText[it].isLineBreak() }

    if (insertedHasGlyphContent) {
      for (style in context.pendingStyles) {
        formattingStore.addRange(FormattingRange(style, rangeStart, rangeEnd))
      }
    }

    for (style in context.pendingStyleRemovals) {
      formattingStore.removeType(style, rangeStart, rangeEnd)
    }
  }

  private fun applyInlineFormatting() {
    val editable = host.editable ?: return
    formatter.applyFormatting(editable, formattingStore.allRanges)
  }

  private fun applyBlockFormatting(
    touchedNewline: Boolean,
    editStart: Int,
    insertedLength: Int,
  ) {
    val editable = host.editable ?: return
    if (touchedNewline) {
      formatter.applyBlockFormatting(editable, blockStore.allRanges)
    } else {
      applyBlockFormattingScopedToEdit(editable, editStart, insertedLength)
    }
  }

  private fun applyBlockFormattingScopedToEdit(
    editable: Editable,
    editStart: Int,
    insertedLength: Int,
  ) {
    val length = editable.length
    val rawStart = editStart.coerceIn(0, length)
    val rawEnd = (editStart + insertedLength).coerceIn(rawStart, length)

    var lineStart = rawStart
    while (lineStart > 0 && editable[lineStart - 1] != '\n') lineStart--
    var lineEnd = rawEnd
    while (lineEnd < length && editable[lineEnd] != '\n') lineEnd++

    formatter.applyBlockFormatting(editable, blockStore.allRanges, lineStart, lineEnd)
  }

  private fun detectLinks(context: EditContext) {
    val editable = host.editable ?: return
    val currentText = editable.toString()
    detectorPipeline.processTextChange(editable, currentText, context.editStart, context.insertedLength)
  }

  /**
   * True when the edit inserted or deleted a line break (so block spans may
   * need to move across lines). Checks the inserted run in the current text
   * and the deleted run in the pre-edit text.
   */
  private fun editTouchedNewline(context: EditContext): Boolean {
    val editable = host.editable
    if (editable != null && context.insertedLength > 0) {
      val end = (context.editStart + context.insertedLength).coerceAtMost(editable.length)
      if ((context.editStart until end).any { editable[it].isLineBreak() }) return true
    }
    if (context.deletedLength > 0) {
      val end = (context.editStart + context.deletedLength).coerceAtMost(context.preEditText.length)
      if ((context.editStart until end).any { context.preEditText[it].isLineBreak() }) return true
    }
    return false
  }

  private fun isAtLineStart(
    editable: CharSequence,
    pos: Int,
  ): Boolean {
    if (pos < 0 || pos > editable.length) return false
    return pos == 0 || editable[pos - 1].isLineBreak()
  }
}
