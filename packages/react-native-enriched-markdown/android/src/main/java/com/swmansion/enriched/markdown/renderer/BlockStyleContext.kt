package com.swmansion.enriched.markdown.renderer

import com.swmansion.enriched.markdown.styles.BaseBlockStyle
import com.swmansion.enriched.markdown.styles.BlockquoteStyle
import com.swmansion.enriched.markdown.styles.CodeBlockStyle
import com.swmansion.enriched.markdown.styles.HeadingStyle
import com.swmansion.enriched.markdown.styles.ListStyle
import com.swmansion.enriched.markdown.styles.ParagraphStyle

enum class BlockType {
  NONE,
  PARAGRAPH,
  HEADING,
  BLOCKQUOTE,
  UNORDERED_LIST,
  ORDERED_LIST,
  CODE_BLOCK,
}

data class BlockStyle(
  val fontSize: Float,
  val fontFamily: String,
  val fontWeight: String,
  val color: Int,
)

private data class BlockStyleEntry(
  val blockType: BlockType,
  val blockStyle: BlockStyle,
  val headingLevel: Int,
)

class BlockStyleContext {
  var currentBlockType = BlockType.NONE
    private set

  private var currentHeadingLevel = 0
  private val blockStyleStack = ArrayDeque<BlockStyleEntry>()

  var blockquoteDepth = 0
  var listDepth = 0
  var listType: ListType? = null
  var listItemNumber = 0
  var taskItemCount = 0
  var accumulatedIndent = 0

  val listItemStarts = mutableListOf<Int>()

  private val orderedListItemNumbers = ArrayDeque<Int>()

  enum class ListType { UNORDERED, ORDERED }

  private fun pushBlockStyle(
    type: BlockType,
    style: BaseBlockStyle,
    headingLevel: Int = 0,
  ) {
    val entry =
      BlockStyleEntry(
        blockType = type,
        blockStyle = BlockStyle(style.fontSize, style.fontFamily, style.fontWeight, style.color),
        headingLevel = headingLevel,
      )

    blockStyleStack.addLast(entry)
    currentBlockType = type
    currentHeadingLevel = headingLevel
  }

  fun popBlockStyle() {
    if (blockStyleStack.isNotEmpty()) {
      blockStyleStack.removeLast()
    }

    val parentStyle = blockStyleStack.lastOrNull()
    if (parentStyle != null) {
      currentBlockType = parentStyle.blockType
      currentHeadingLevel = parentStyle.headingLevel
    } else {
      currentBlockType = BlockType.NONE
      currentHeadingLevel = 0
    }
  }

  fun setParagraphStyle(style: ParagraphStyle) = pushBlockStyle(BlockType.PARAGRAPH, style)

  fun setHeadingStyle(
    style: HeadingStyle,
    level: Int,
  ) = pushBlockStyle(BlockType.HEADING, style, level)

  fun setBlockquoteStyle(style: BlockquoteStyle) = pushBlockStyle(BlockType.BLOCKQUOTE, style)

  fun setUnorderedListStyle(style: ListStyle) {
    listType = ListType.UNORDERED
    pushBlockStyle(BlockType.UNORDERED_LIST, style)
  }

  fun setOrderedListStyle(style: ListStyle) {
    listType = ListType.ORDERED
    pushBlockStyle(BlockType.ORDERED_LIST, style)
  }

  fun setCodeBlockStyle(style: CodeBlockStyle) = pushBlockStyle(BlockType.CODE_BLOCK, style)

  fun incrementListItemNumber() {
    listItemNumber++
  }

  fun resetListItemNumber(startNumber: Int = 1) {
    // ListItemRenderer pre-increments, so the counter starts one below the
    // first rendered number.
    listItemNumber = startNumber - 1
  }

  fun pushOrderedListItemNumber() {
    orderedListItemNumbers.addLast(listItemNumber)
  }

  fun popOrderedListItemNumber() {
    if (orderedListItemNumbers.isNotEmpty()) {
      listItemNumber = orderedListItemNumbers.removeLast()
    }
  }

  fun clearListStyle() {
    popBlockStyle()

    if (listDepth == 0) {
      listType = null
      listItemNumber = 0
      orderedListItemNumbers.clear()
    }
  }

  fun requireBlockStyle(): BlockStyle {
    val entry = blockStyleStack.lastOrNull()
    return entry?.blockStyle
      ?: throw IllegalStateException(
        "BlockStyle is null. Inline renderers must be used within a block context.",
      )
  }

  fun currentBlockStyleOrNull(): BlockStyle? = blockStyleStack.lastOrNull()?.blockStyle

  fun resetForNewRender() {
    blockStyleStack.clear()
    currentBlockType = BlockType.NONE
    currentHeadingLevel = 0
    blockquoteDepth = 0
    listDepth = 0
    listType = null
    listItemNumber = 0
    taskItemCount = 0
    accumulatedIndent = 0
    listItemStarts.clear()
    orderedListItemNumbers.clear()
  }
}
